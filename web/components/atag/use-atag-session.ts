"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkspaceClient,
  AuthState,
  DeviceMetadataPatch,
  ProvisioningBundle,
  ProvisioningBundleRequest,
  TagDevice,
} from "@/lib/contracts";
import {
  ClientError,
  pollOperation,
  toClientError,
  validateAgentBaseUrl,
} from "@/lib/client-support";
import type { BridgeHealth } from "@/lib/agent/bridge-client";
import type { QuerySettings, WorkspaceStats, BackupSummary as BackupPreview } from "@/lib/workspace/types";
export type { QuerySettings, WorkspaceStats, BackupSummary as BackupPreview } from "@/lib/workspace/types";
import type { AppleLoginInput, AppleLoginSnapshot } from "@/lib/auth/apple-login";
import { BrowserWorkspaceClient } from "@/lib/workspace/browser-workspace-client";

/**
 * Loopback bridge: supplies Anisette and forwards allowlisted Apple requests for
 * sign-in and report downloads. Devices, keys and history live in the browser
 * workspace regardless of this state.
 */
export type BridgeConnection =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "connected"; health: BridgeHealth }
  | { status: "error"; error: ClientError };

export type LoadState = "idle" | "loading" | "ready" | "error";

export type RefreshTask =
  | { status: "running"; phase: "queued" | "running" | "starting" }
  | { status: "done"; newReportCount: number; at: number }
  | { status: "failed"; error: ClientError; at: number };

export const IDLE_APPLE_LOGIN: AppleLoginSnapshot = {
  phase: "idle",
  busy: false,
  progress: null,
  accountLabel: null,
  methods: [],
  selectedMethodId: null,
  expiresAt: null,
  attemptsRemaining: 3,
  sendsRemaining: 5,
  error: null,
};

export interface AtagSession {
  /** The browser workspace; null only when local storage cannot be opened. */
  client: WorkspaceClient | null;
  workspaceReady: boolean;
  /** Set when browser storage cannot be opened; nothing is pretended to be saved. */
  storageError: ClientError | null;
  stats: WorkspaceStats | null;
  /** Apple query session held by this browser (not by the bridge). */
  auth: AuthState | null;
  /** In-progress browser Apple sign-in; secrets never appear in this snapshot. */
  appleLogin: AppleLoginSnapshot;
  bridge: BridgeConnection;
  devices: TagDevice[];
  devicesState: LoadState;
  devicesError: ClientError | null;
  refreshTasks: Record<string, RefreshTask>;
  /** Bumps when reports for a device may have changed (refresh finished, restore, import). */
  reportsVersion: number;
  connectBridge(url: string): Promise<boolean>;
  cancelBridgeConnect(): void;
  disconnectBridge(): void;
  reloadDevices(): Promise<void>;
  updateDevice(id: string, patch: DeviceMetadataPatch): Promise<TagDevice>;
  deleteDevice(id: string): Promise<void>;
  refreshReports(id: string): void;
  exportBackup(password: string, includeAccount: boolean): Promise<string>;
  previewBackup(text: string, password: string): Promise<BackupPreview>;
  restoreBackup(text: string, password: string): Promise<{ deviceCount: number; reportCount: number }>;
  /** Starts sign-in through the connected bridge; resolves at choose_method or complete. */
  startAppleLogin(input: AppleLoginInput): Promise<void>;
  requestAppleCode(methodId: string): Promise<void>;
  submitAppleCode(code: string): Promise<void>;
  /** Drops an unfinished sign-in and its secrets; an existing session is kept. */
  cancelAppleLogin(): void;
  /** Removes only the query session; devices, keys and reports stay. */
  logoutApple(): Promise<void>;
  getQuerySettings(id: string): Promise<QuerySettings>;
  updateQuerySettings(id: string, patch: Partial<QuerySettings>): Promise<void>;
  /** Generates keys locally and persists the draft profile before returning the transient package. */
  createProvisioningBundle(input: ProvisioningBundleRequest): Promise<ProvisioningBundle>;
  /** Rebuilds the saved profile's configuration package; never generates new keys. */
  getProvisioningBundle(id: string): Promise<ProvisioningBundle>;
  /** Real workspace devices, independent of which source is shown. */
  listWorkspaceDevices(): Promise<TagDevice[]>;
  /** Bind a generated profile to the Tag that durably committed its keys. */
  confirmProvisioning(id: string, serial: string | null, firmwareVersion: string | null): Promise<void>;
}

const STORAGE_UNAVAILABLE = "无法打开此浏览器的本地存储（可能是隐私模式、存储被禁用或空间不足）。真实设备数据不会被保存，请换用普通窗口或检查站点存储权限。";

export function useAtagSession(): AtagSession {
  const workspaceRef = useRef<BrowserWorkspaceClient | null>(null);

  const [client, setClient] = useState<WorkspaceClient | null>(null);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [storageError, setStorageError] = useState<ClientError | null>(null);
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [workspaceAuth, setWorkspaceAuth] = useState<AuthState | null>(null);
  const [appleLogin, setAppleLogin] = useState<AppleLoginSnapshot>(IDLE_APPLE_LOGIN);
  const [bridge, setBridge] = useState<BridgeConnection>({ status: "idle" });
  const [devices, setDevices] = useState<TagDevice[]>([]);
  // Workspace devices load right after hydration; start as loading so the empty state never flashes.
  const [devicesState, setDevicesState] = useState<LoadState>("loading");
  const [devicesError, setDevicesError] = useState<ClientError | null>(null);
  const [refreshTasks, setRefreshTasks] = useState<Record<string, RefreshTask>>({});
  const [reportsVersion, setReportsVersion] = useState(0);

  /** Aborts loads and refresh polls; replaced only on unmount. */
  const scopeRef = useRef<AbortController>(new AbortController());
  /** Aborts an in-flight bridge connect; independent of the data scope. */
  const bridgeScopeRef = useRef<AbortController>(new AbortController());
  const clientRef = useRef<WorkspaceClient | null>(null);

  const resetBridgeScope = useCallback(() => {
    bridgeScopeRef.current.abort();
    bridgeScopeRef.current = new AbortController();
    return bridgeScopeRef.current.signal;
  }, []);

  const loadDevices = useCallback(async (target: WorkspaceClient, signal: AbortSignal) => {
    setDevicesState("loading");
    setDevicesError(null);
    try {
      const list = await target.listDevices(signal);
      if (signal.aborted) return;
      setDevices(list);
      setDevicesState("ready");
    } catch (error) {
      if (signal.aborted) return;
      setDevicesError(toClientError(error));
      setDevicesState("error");
    }
  }, []);

  const requireWorkspace = useCallback((): BrowserWorkspaceClient => {
    const ws = workspaceRef.current;
    if (!ws) throw storageError ?? new ClientError("INTERNAL_ERROR", STORAGE_UNAVAILABLE);
    return ws;
  }, [storageError]);

  /** Stats and the browser-held Apple session; cheap, local, no network. */
  const refreshWorkspaceInfo = useCallback(async () => {
    const ws = workspaceRef.current;
    if (!ws) return;
    try {
      const [nextStats, nextAuth] = await Promise.all([ws.getStats(), ws.getAuthState()]);
      setStats(nextStats);
      setWorkspaceAuth(nextAuth);
      setStorageError(null);
    } catch (error) {
      setStorageError(toClientError(error));
    }
  }, []);

  /** After a workspace mutation: re-read stats and reload devices. */
  const afterWorkspaceChange = useCallback(async () => {
    await refreshWorkspaceInfo();
    if (workspaceRef.current) {
      setReportsVersion((v) => v + 1);
      await loadDevices(workspaceRef.current, scopeRef.current.signal);
    }
  }, [loadDevices, refreshWorkspaceInfo]);

  const connectBridge = useCallback(
    async (url: string): Promise<boolean> => {
      const signal = resetBridgeScope();
      const ws = workspaceRef.current;
      if (!ws) {
        setBridge({ status: "error", error: new ClientError("INTERNAL_ERROR", STORAGE_UNAVAILABLE) });
        return false;
      }
      const checked = validateAgentBaseUrl(url);
      if (!checked.ok) {
        setBridge({ status: "error", error: new ClientError("INVALID_REQUEST", checked.message) });
        return false;
      }
      // A new bridge never continues a sign-in that started on another one.
      ws.cancelAppleLogin();
      ws.disconnectBridge();
      setBridge({ status: "connecting" });
      try {
        const health = await ws.connectBridge(checked.url, signal);
        if (signal.aborted) {
          ws.disconnectBridge();
          return false;
        }
        setBridge({ status: "connected", health });
        return true;
      } catch (error) {
        if (signal.aborted) {
          setBridge((current) => (current.status === "connecting" ? { status: "idle" } : current));
          return false;
        }
        setBridge({ status: "error", error: toClientError(error) });
        return false;
      }
    },
    [resetBridgeScope],
  );

  const cancelBridgeConnect = useCallback(() => {
    resetBridgeScope();
    workspaceRef.current?.cancelAppleLogin();
    workspaceRef.current?.disconnectBridge();
    setBridge({ status: "idle" });
  }, [resetBridgeScope]);

  const disconnectBridge = useCallback(() => {
    resetBridgeScope();
    workspaceRef.current?.cancelAppleLogin();
    workspaceRef.current?.disconnectBridge();
    setBridge({ status: "idle" });
    // Devices, history, key generation and a finished sign-in are unaffected; only network work stops.
  }, [resetBridgeScope]);

  const reloadDevices = useCallback(async () => {
    const current = clientRef.current;
    if (!current) {
      setDevicesError(storageError ?? new ClientError("INTERNAL_ERROR", STORAGE_UNAVAILABLE));
      setDevicesState("error");
      return;
    }
    void refreshWorkspaceInfo();
    await loadDevices(current, scopeRef.current.signal);
  }, [loadDevices, refreshWorkspaceInfo, storageError]);

  const updateDevice = useCallback(async (id: string, patch: DeviceMetadataPatch) => {
    const current = clientRef.current;
    if (!current) throw new ClientError("INTERNAL_ERROR", STORAGE_UNAVAILABLE);
    const updated = await current.updateDevice(id, patch, scopeRef.current.signal);
    setDevices((list) => list.map((device) => (device.id === id ? updated : device)));
    return updated;
  }, []);

  const deleteDevice = useCallback(
    async (id: string) => {
      const current = clientRef.current;
      if (!current) throw new ClientError("INTERNAL_ERROR", STORAGE_UNAVAILABLE);
      await current.deleteDevice(id, scopeRef.current.signal);
      setDevices((list) => list.filter((device) => device.id !== id));
      void refreshWorkspaceInfo();
    },
    [refreshWorkspaceInfo],
  );

  const refreshReports = useCallback(
    (id: string) => {
      const current = clientRef.current;
      if (!current) return;
      const signal = scopeRef.current.signal;
      const setTask = (task: RefreshTask) => setRefreshTasks((tasks) => ({ ...tasks, [id]: task }));
      setTask({ status: "running", phase: "starting" });
      void (async () => {
        // Every await may cross an unmount; a stale scope must never touch state.
        const live = () => !signal.aborted && clientRef.current === current;
        try {
          const started = await current.refreshReports(id, signal);
          if (!live()) return;
          setTask({ status: "running", phase: started.status === "running" ? "running" : "queued" });
          const final = await pollOperation(current, started, {
            signal,
            onUpdate: (op) => {
              if (live() && (op.status === "queued" || op.status === "running")) setTask({ status: "running", phase: op.status });
            },
          });
          if (!live()) return;
          if (final.status === "succeeded") {
            const device = await current.getDevice(id, signal);
            if (!live()) return;
            setDevices((list) => list.map((item) => (item.id === id ? device : item)));
            setReportsVersion((v) => v + 1);
            setTask({ status: "done", newReportCount: final.result?.newReportCount ?? 0, at: Date.now() });
            void refreshWorkspaceInfo();
          } else {
            const error =
              final.error
                ? new ClientError(final.error.code, final.error.message, { retryable: final.error.retryable })
                : new ClientError(final.status === "cancelled" ? "CANCELLED" : "INTERNAL_ERROR", "刷新任务未成功完成。");
            setTask({ status: "failed", error, at: Date.now() });
            // The workspace persists AUTH_EXPIRED; re-read so settings and detail show it.
            void refreshWorkspaceInfo();
          }
        } catch (error) {
          if (!live()) return;
          setTask({ status: "failed", error: toClientError(error), at: Date.now() });
          void refreshWorkspaceInfo();
        }
      })();
    },
    [refreshWorkspaceInfo],
  );

  /* ---------- Workspace data operations ---------- */

  const exportBackup = useCallback(
    (password: string, includeAccount: boolean) => requireWorkspace().exportBackup(password, includeAccount),
    [requireWorkspace],
  );

  const previewBackup = useCallback(
    (text: string, password: string) => requireWorkspace().previewBackup(text, password),
    [requireWorkspace],
  );

  const restoreBackup = useCallback(
    async (text: string, password: string) => {
      const result = await requireWorkspace().restoreBackup(text, password);
      await afterWorkspaceChange();
      return result;
    },
    [afterWorkspaceChange, requireWorkspace],
  );

  /* ---------- Apple sign-in: browser-side, through the connected bridge only ---------- */

  // Every action re-reads stats and auth afterwards, whether it succeeded or not.
  const startAppleLogin = useCallback(
    async (input: AppleLoginInput) => {
      try {
        await requireWorkspace().startAppleLogin(input);
      } finally {
        void refreshWorkspaceInfo();
      }
    },
    [refreshWorkspaceInfo, requireWorkspace],
  );

  const requestAppleCode = useCallback(
    async (methodId: string) => {
      try {
        await requireWorkspace().requestAppleCode(methodId);
      } finally {
        void refreshWorkspaceInfo();
      }
    },
    [refreshWorkspaceInfo, requireWorkspace],
  );

  const submitAppleCode = useCallback(
    async (code: string) => {
      try {
        await requireWorkspace().submitAppleCode(code);
      } finally {
        void refreshWorkspaceInfo();
      }
    },
    [refreshWorkspaceInfo, requireWorkspace],
  );

  const cancelAppleLogin = useCallback(() => {
    workspaceRef.current?.cancelAppleLogin();
  }, []);

  const logoutApple = useCallback(async () => {
    try {
      await requireWorkspace().logoutApple();
    } finally {
      await refreshWorkspaceInfo();
    }
  }, [refreshWorkspaceInfo, requireWorkspace]);

  const getQuerySettings = useCallback((id: string) => requireWorkspace().getQuerySettings(id), [requireWorkspace]);

  const updateQuerySettings = useCallback(
    (id: string, patch: Partial<QuerySettings>) => requireWorkspace().updateQuerySettings(id, patch),
    [requireWorkspace],
  );

  const createProvisioningBundle = useCallback(
    async (input: ProvisioningBundleRequest) => {
      const bundle = await requireWorkspace().createProvisioningBundle(input);
      await afterWorkspaceChange();
      return bundle;
    },
    [afterWorkspaceChange, requireWorkspace],
  );

  const getProvisioningBundle = useCallback((id: string) => requireWorkspace().getProvisioningBundle(id), [requireWorkspace]);

  const listWorkspaceDevices = useCallback(() => requireWorkspace().listDevices(), [requireWorkspace]);

  const confirmProvisioning = useCallback(
    async (id: string, serial: string | null, firmwareVersion: string | null) => {
      await requireWorkspace().confirmProvisioning(id, serial, firmwareVersion);
      await afterWorkspaceChange();
    },
    [afterWorkspaceChange, requireWorkspace],
  );

  // Open the browser workspace on mount.
  useEffect(() => {
    let unsubscribeLogin: (() => void) | null = null;
    try {
      const ws = new BrowserWorkspaceClient();
      workspaceRef.current = ws;
      clientRef.current = ws;
      setClient(ws);
      setWorkspaceReady(true);
      setAppleLogin(ws.getAppleLoginState());
      let lastPhase = ws.getAppleLoginState().phase;
      unsubscribeLogin = ws.subscribeAppleLogin((snapshot) => {
        setAppleLogin(snapshot);
        // Account persisted (or a sign-in ended): re-read stats and auth once per transition.
        if (snapshot.phase !== lastPhase && ["complete", "error", "expired", "idle"].includes(snapshot.phase)) {
          void refreshWorkspaceInfo();
        }
        lastPhase = snapshot.phase;
      });
      const signal = scopeRef.current.signal;
      void refreshWorkspaceInfo();
      void loadDevices(ws, signal);
    } catch (error) {
      const failure = new ClientError("INTERNAL_ERROR", `${STORAGE_UNAVAILABLE}（${toClientError(error).message}）`);
      setStorageError(failure);
      setDevicesError(failure);
      setDevicesState("error");
    }
    const scope = scopeRef;
    const bridgeScope = bridgeScopeRef;
    return () => {
      unsubscribeLogin?.();
      // Navigation / unmount never lets a sign-in finish in the background.
      workspaceRef.current?.cancelAppleLogin();
      scope.current.abort();
      bridgeScope.current.abort();
      workspaceRef.current?.disconnectBridge();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    client,
    workspaceReady,
    storageError,
    stats,
    auth: workspaceAuth,
    appleLogin,
    bridge,
    devices,
    devicesState,
    devicesError,
    refreshTasks,
    reportsVersion,
    connectBridge,
    cancelBridgeConnect,
    disconnectBridge,
    reloadDevices,
    updateDevice,
    deleteDevice,
    refreshReports,
    exportBackup,
    previewBackup,
    restoreBackup,
    startAppleLogin,
    requestAppleCode,
    submitAppleCode,
    cancelAppleLogin,
    logoutApple,
    getQuerySettings,
    updateQuerySettings,
    createProvisioningBundle,
    getProvisioningBundle,
    listWorkspaceDevices,
    confirmProvisioning,
  };
}
