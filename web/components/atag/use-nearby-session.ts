"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  BleAvailability,
  BleClient,
  BleSessionSnapshot,
  ProvisioningStatus,
  TagSettings,
} from "@/lib/contracts";
import { isBleError } from "@/lib/ble/ble-error";
import { WebBluetoothClient } from "@/lib/ble/web-bluetooth-client";

export type NearbyTask =
  | "connect"
  | "pair"
  | "load"
  | "refresh"
  | "name"
  | "settings"
  | "keys"
  | "reboot"
  | "factory_reset"
  | "led_find"
  | "led_stop";
// LED control has a transient acknowledgement, never a Flash commit outcome.
export type CommitOperation = "keys" | "name" | "settings";

export interface Notice {
  tone: "info" | "error";
  text: string;
}

/**
 * Result of one persistent update. `committed` only when the status
 * notification for *this* operation reports its Flash-commit code;
 * `not_sent` when validation or state stopped the write before it left.
 */
export type CommitOutcome =
  | { kind: "committed"; status: ProvisioningStatus; at: string }
  | { kind: "rejected"; status: ProvisioningStatus; at: string }
  | { kind: "unknown"; message: string; at: string }
  | { kind: "not_sent"; message: string; at: string };

/**
 * A reboot / factory-reset command that left (or may have left) the browser.
 * `sent`: the ATT write succeeded — delivered, not necessarily executed.
 * `unknown`: the write failed in a way (disconnect, timeout, GATT error) that
 * cannot rule out the firmware receiving and executing it.
 */
export interface CommandSent {
  kind: "reboot" | "factory_reset";
  delivery: "sent" | "unknown";
  /** When the command was initiated; the reference point for verification. */
  at: string;
  serial: string | null;
  previousName: string | null;
}

export type LedAction = "find" | "stop";

/**
 * Result of one LED find / stop request. Kept apart from CommitOutcome: the
 * firmware acknowledges a transient action (7 started, 8 stopped, 9 rejected)
 * and never a Flash commit. `confirmed` means the firmware accepted the
 * command; telemetry does not report whether the light is currently on.
 */
export type LedOutcome =
  | { kind: "confirmed"; action: LedAction; at: string }
  | { kind: "rejected"; action: LedAction; cause: number; at: string }
  | { kind: "unknown"; action: LedAction; message: string; at: string }
  | { kind: "not_sent"; action: LedAction; message: string; at: string };

/** Firmware rejection causes for result 9 (status byte 2). */
export const LED_REJECT_TEXT: Record<number, string> = {
  1: "设备报告没有 LED 硬件。可用按键辨认这台 Tag。",
  2: "设备上保存的设置未允许 LED 查找。请在“参数”页开启“允许 LED 查找”并保存，收到保存回执后再试。",
  3: "设备正在进行固件升级（OTA），升级期间不能闪灯。",
};

const LED_ACCEPT_CODE: Record<LedAction, number> = { find: 7, stop: 8 };
const LED_REJECT_CODE = 9;

export function interpretLed(status: ProvisioningStatus, action: LedAction): LedOutcome {
  const at = new Date().toISOString();
  if (status.operation === "led" && status.resultCode === LED_ACCEPT_CODE[action]) return { kind: "confirmed", action, at };
  if (status.operation === "led" && status.resultCode === LED_REJECT_CODE) return { kind: "rejected", action, cause: status.errorCode, at };
  return { kind: "unknown", action, message: "收到的状态回执不属于本次 LED 指令。", at };
}

export type LedHardware = "unknown" | "present" | "absent";

/**
 * LED capability from telemetry read on the current link (or, once
 * disconnected, the last link). Missing telemetry is unknown, never absent.
 */
export function ledHardware(snapshot: BleSessionSnapshot): LedHardware {
  const { telemetry, telemetryReceivedAt, connectedAt } = snapshot;
  if (!telemetry || !telemetryReceivedAt) return "unknown";
  if (isLinkUp(snapshot) && connectedAt && Date.parse(telemetryReceivedAt) < Date.parse(connectedAt)) return "unknown";
  return telemetry.flags.hasLed ? "present" : "absent";
}

const COMMIT_CODE: Record<CommitOperation, number> = { keys: 1, name: 3, settings: 5 };
const REJECT_CODE: Record<CommitOperation, number> = { keys: 2, name: 4, settings: 6 };
const NOT_SENT_CODES = new Set(["invalid_name", "invalid_settings", "invalid_package", "busy", "not_connected", "no_device"]);
/** Commands stopped before any write left the browser; any other failure may have reached the firmware. */
const COMMAND_NOT_SENT_CODES = new Set([...NOT_SENT_CODES, "unsupported", "incompatible", "cancelled"]);
/** The LED client preflights encryption and throws pairing_failed before any control write; it never auto-pairs. */
const LED_NOT_SENT_CODES = new Set([...COMMAND_NOT_SENT_CODES, "pairing_failed"]);

export function interpretCommit(status: ProvisioningStatus, operation: CommitOperation): CommitOutcome {
  const at = new Date().toISOString();
  if (status.operation === operation && status.resultCode === COMMIT_CODE[operation] && status.commitConfirmed) {
    return { kind: "committed", status, at };
  }
  if (status.operation === operation && status.resultCode === REJECT_CODE[operation]) {
    return { kind: "rejected", status, at };
  }
  return { kind: "unknown", message: "收到的状态回执不属于本次操作，不能确认已保存。", at };
}

function failureOutcome(error: unknown, fallback: string): CommitOutcome {
  const at = new Date().toISOString();
  const message = isBleError(error) ? error.message : error instanceof Error ? error.message : fallback;
  if (isBleError(error) && NOT_SENT_CODES.has(error.code)) return { kind: "not_sent", message, at };
  return { kind: "unknown", message, at };
}

function errorText(error: unknown, fallback: string): string {
  return isBleError(error) ? error.message : error instanceof Error ? error.message : fallback;
}

export const EMPTY_SNAPSHOT: BleSessionSnapshot = {
  state: "disconnected",
  device: null,
  identity: null,
  deviceName: null,
  batteryMillivolts: null,
  telemetry: null,
  settings: null,
  encryption: "unknown",
  buttonCounter: null,
  lastButtonPressAt: null,
  connectedAt: null,
  estimatedConnectionDeadline: null,
  telemetryReceivedAt: null,
  busyOperation: null,
};

export function isLinkUp(snapshot: BleSessionSnapshot): boolean {
  return snapshot.state === "connected" || snapshot.state === "pairing" || snapshot.state === "writing";
}

export interface NearbySession {
  /** Web Bluetooth availability in this browser; null until the panel first opens. */
  availability: BleAvailability | null;
  snapshot: BleSessionSnapshot;
  linkUp: boolean;
  everConnected: boolean;
  lastDisconnectAt: string | null;
  task: NearbyTask | null;
  busy: boolean;
  notice: Notice | null;
  clearNotice(): void;
  pairingError: string | null;
  protectedErrors: string[];
  /** Presses seen on this connection; the baseline counter read never counts. */
  pressCount: number;
  lastPressAt: string | null;
  nameOutcome: CommitOutcome | null;
  settingsOutcome: CommitOutcome | null;
  keysOutcome: CommitOutcome | null;
  clearKeysOutcome(): void;
  commandSent: CommandSent | null;
  /** Last LED request on the current link; cleared when a new link starts. */
  ledOutcome: LedOutcome | null;
  pick(): void;
  reconnect(): void;
  disconnect(): void;
  enableEncryption(): void;
  reloadProtected(): void;
  refresh(): void;
  saveName(name: string): Promise<CommitOutcome | null>;
  saveSettings(settings: TagSettings): Promise<CommitOutcome | null>;
  applyKeys(bytes: Uint8Array): Promise<CommitOutcome | null>;
  reboot(): Promise<boolean>;
  factoryReset(): Promise<boolean>;
  /** true: find (≤ 10 s, firmware-timed); false: stop. Never changes settings or extends the link. */
  identifyLed(active: boolean): Promise<LedOutcome | null>;
}

/**
 * Owns exactly one BLE client for the nearby-management panel. The client is
 * created when the panel opens and disposed when it closes, so panels never
 * compete for one link.
 * All GATT work goes through `run`, which refuses to start a second
 * operation while one is in flight.
 */
export function useNearbySession(open: boolean): NearbySession {
  const [availability, setAvailability] = useState<BleAvailability | null>(null);
  const [snapshot, setSnapshot] = useState<BleSessionSnapshot>(EMPTY_SNAPSHOT);
  const [everConnected, setEverConnected] = useState(false);
  const [lastDisconnectAt, setLastDisconnectAt] = useState<string | null>(null);
  const [task, setTask] = useState<NearbyTask | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [protectedErrors, setProtectedErrors] = useState<string[]>([]);
  const [pressCount, setPressCount] = useState(0);
  const [lastPressAt, setLastPressAt] = useState<string | null>(null);
  const [nameOutcome, setNameOutcome] = useState<CommitOutcome | null>(null);
  const [settingsOutcome, setSettingsOutcome] = useState<CommitOutcome | null>(null);
  const [keysOutcome, setKeysOutcome] = useState<CommitOutcome | null>(null);
  const [commandSent, setCommandSent] = useState<CommandSent | null>(null);
  const [ledOutcome, setLedOutcome] = useState<LedOutcome | null>(null);

  const clientRef = useRef<BleClient | null>(null);
  const taskRef = useRef<NearbyTask | null>(null);

  // Create / dispose the single client while open.
  useEffect(() => {
    if (!open) return;
    const next: BleClient = new WebBluetoothClient();
    setAvailability(next.getAvailability());

    clientRef.current = next;
    taskRef.current = null;
    setSnapshot(next.getSession());
    setEverConnected(false);
    setLastDisconnectAt(null);
    setTask(null);
    setNotice(null);
    setPairingError(null);
    setProtectedErrors([]);
    setPressCount(0);
    setLastPressAt(null);
    setNameOutcome(null);
    setSettingsOutcome(null);
    setKeysOutcome(null);
    setCommandSent(null);
    setLedOutcome(null);

    let prev = next.getSession();
    const unsubscribe = next.subscribeSession((snap) => {
      if (clientRef.current !== next) return;
      const wasUp = isLinkUp(prev);
      const up = isLinkUp(snap);
      if (up) {
        setEverConnected(true);
        setLastDisconnectAt(null);
      } else if (wasUp) {
        setLastDisconnectAt(new Date().toISOString());
      }
      if (snap.connectedAt !== prev.connectedAt) {
        // New link: the next counter value is a baseline, not a press.
        setPressCount(0);
        setLastPressAt(null);
        setPairingError(null);
        setProtectedErrors([]);
        setLedOutcome(null);
      } else if (up) {
        const counterChanged =
          prev.buttonCounter !== null && snap.buttonCounter !== null && snap.buttonCounter !== prev.buttonCounter;
        const pressStamped = !!snap.lastButtonPressAt && snap.lastButtonPressAt !== prev.lastButtonPressAt;
        if (counterChanged || pressStamped) {
          setPressCount((n) => n + 1);
          setLastPressAt(snap.lastButtonPressAt ?? new Date().toISOString());
        }
      }
      prev = snap;
      setSnapshot(snap);
    });

    return () => {
      unsubscribe();
      next.dispose();
      if (clientRef.current === next) clientRef.current = null;
      setSnapshot(EMPTY_SNAPSHOT);
    };
  }, [open]);

  /**
   * Single-flight runner. `fn` is invoked synchronously (before any await)
   * so `requestDevice` stays inside the click's user activation.
   */
  const run = useCallback(<T,>(name: NearbyTask, fn: (c: BleClient) => Promise<T>): Promise<T | null> => {
    const c = clientRef.current;
    if (!c || taskRef.current) return Promise.resolve(null);
    taskRef.current = name;
    setTask(name);
    let pending: Promise<T>;
    try {
      pending = fn(c);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.finally(() => {
      if (clientRef.current === c && taskRef.current === name) {
        taskRef.current = null;
        setTask(null);
      }
    });
  }, []);

  const isCurrent = (c: BleClient) => clientRef.current === c;

  const connectFlow = useCallback(
    (withPicker: boolean) => {
      setNotice(null);
      void run("connect", async (c) => {
        try {
          if (withPicker || !c.deviceInfo) await c.requestDevice();
          await c.connect();
        } catch (error) {
          if (!isCurrent(c)) return;
          if (isBleError(error) && error.code === "cancelled") setNotice({ tone: "info", text: "已取消选择。可以随时再选。" });
          else setNotice({ tone: "error", text: errorText(error, "连接失败。") });
        }
      });
    },
    [run],
  );

  const pick = useCallback(() => connectFlow(true), [connectFlow]);
  const reconnect = useCallback(() => connectFlow(false), [connectFlow]);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
  }, []);

  /** Sequential protected reads: never Promise.all several GATT operations. */
  const loadProtected = async (c: BleClient) => {
    const errors: string[] = [];
    const steps: [string, () => Promise<unknown>][] = [
      ["名称", () => c.readName()],
      ["运行参数", () => c.readSettings()],
      ["遥测", () => c.readTelemetry()],
    ];
    for (const [label, read] of steps) {
      try {
        await read();
      } catch (error) {
        errors.push(`${label}读取失败：${errorText(error, "未知错误")}`);
        if (isBleError(error) && (error.code === "disconnected" || error.code === "not_connected")) break;
      }
    }
    if (isCurrent(c)) setProtectedErrors(errors);
  };

  const enableEncryption = useCallback(() => {
    setNotice(null);
    setPairingError(null);
    void run("pair", async (c) => {
      try {
        await c.ensureEncrypted();
      } catch (error) {
        if (isCurrent(c)) setPairingError(errorText(error, "加密请求失败。"));
        return;
      }
      await loadProtected(c);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const reloadProtected = useCallback(() => {
    void run("load", (c) => loadProtected(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  const refresh = useCallback(() => {
    void run("refresh", async (c) => {
      try {
        if (c.getSession().encryption === "encrypted") await c.readTelemetry();
        else await c.readBattery();
      } catch (error) {
        if (isCurrent(c)) setNotice({ tone: "error", text: errorText(error, "读取失败。") });
      }
    });
  }, [run]);

  const commit = useCallback(
    async (
      name: "name" | "settings" | "keys",
      operation: CommitOperation,
      write: (c: BleClient) => Promise<ProvisioningStatus>,
      setOutcome: (o: CommitOutcome) => void,
    ) => {
      const outcome = await run(name, async (c) => {
        let result: CommitOutcome;
        try {
          result = interpretCommit(await write(c), operation);
        } catch (error) {
          result = failureOutcome(error, "写入失败，结果未知。");
        }
        if (isCurrent(c)) setOutcome(result);
        return result;
      });
      return outcome;
    },
    [run],
  );

  const saveName = useCallback(
    (value: string) => commit("name", "name", (c) => c.writeName(value), setNameOutcome),
    [commit],
  );
  const saveSettings = useCallback(
    (value: TagSettings) => commit("settings", "settings", (c) => c.writeSettings(value), setSettingsOutcome),
    [commit],
  );
  const applyKeys = useCallback(
    (bytes: Uint8Array) => commit("keys", "keys", (c) => c.applyConfiguration(bytes), setKeysOutcome),
    [commit],
  );

  const sendCommand = useCallback(
    async (which: "reboot" | "factory_reset") => {
      setNotice(null);
      const ok = await run(which, async (c) => {
        const snap = c.getSession();
        const at = new Date().toISOString();
        let delivery: CommandSent["delivery"] = "sent";
        try {
          if (which === "reboot") await c.reboot();
          else await c.factoryReset();
        } catch (error) {
          if (isBleError(error) && COMMAND_NOT_SENT_CODES.has(error.code)) {
            if (isCurrent(c)) setNotice({ tone: "error", text: `指令未发送：${errorText(error, "未知原因。")}` });
            return false;
          }
          // Disconnect / timeout / NetworkError: the firmware may have acted before the ATT response arrived.
          delivery = "unknown";
        }
        if (isCurrent(c)) {
          setCommandSent({
            kind: which,
            delivery,
            at,
            serial: snap.identity?.serial ?? null,
            previousName: snap.deviceName ?? snap.device?.name ?? null,
          });
        }
        return delivery === "sent";
      });
      return !!ok;
    },
    [run],
  );

  const reboot = useCallback(() => sendCommand("reboot"), [sendCommand]);
  const factoryReset = useCallback(() => sendCommand("factory_reset"), [sendCommand]);
  const identifyLed = useCallback(
    (active: boolean) => {
      const action: LedAction = active ? "find" : "stop";
      setNotice(null);
      return run(active ? "led_find" : "led_stop", async (c) => {
        let result: LedOutcome;
        try {
          if (!c.identifyLed) throw new Error("此浏览器客户端不支持 LED 指令。");
          result = interpretLed(await c.identifyLed(active), action);
        } catch (error) {
          const at = new Date().toISOString();
          const message = errorText(error, "LED 指令失败。");
          result =
            !c.identifyLed || (isBleError(error) && LED_NOT_SENT_CODES.has(error.code))
              ? { kind: "not_sent", action, message, at }
              : { kind: "unknown", action, message, at };
        }
        if (isCurrent(c)) setLedOutcome(result);
        return result;
      });
    },
    [run],
  );

  return {
    availability,
    snapshot,
    linkUp: isLinkUp(snapshot),
    everConnected,
    lastDisconnectAt,
    task,
    busy: task !== null || snapshot.busyOperation !== null,
    notice,
    clearNotice: () => setNotice(null),
    pairingError,
    protectedErrors,
    pressCount,
    lastPressAt,
    nameOutcome,
    settingsOutcome,
    keysOutcome,
    clearKeysOutcome: () => setKeysOutcome(null),
    commandSent,
    ledOutcome,
    pick,
    reconnect,
    disconnect,
    enableEncryption,
    reloadProtected,
    refresh,
    saveName,
    saveSettings,
    applyKeys,
    reboot,
    factoryReset,
    identifyLed,
  };
}

/* ---------------- Clock & countdown ---------------- */

function subscribeSecond(notify: () => void) {
  const id = window.setInterval(notify, 1000);
  return () => window.clearInterval(id);
}
const noopSubscribe = () => () => {};

/** Current time at second resolution, re-rendering once per second only while `active`. */
export function useNow(active: boolean): number {
  const second = useSyncExternalStore(
    active ? subscribeSecond : noopSubscribe,
    () => Math.floor(Date.now() / 1000),
    () => 0,
  );
  return second * 1000;
}

export interface SessionCountdown {
  seconds: number;
  /** `telemetry`: authoritative device value; `estimate`: computed from connection time. */
  source: "telemetry" | "estimate";
}

export const DEFAULT_CONNECTION_SECONDS = 120;

/**
 * Remaining connection time. Uses telemetry + telemetryReceivedAt once
 * telemetry for this link exists; before that, the adapter's estimate (or
 * connectedAt + 120 s). Returns null when the link is down so a stale
 * countdown never reads as online.
 */
export function sessionCountdown(snapshot: BleSessionSnapshot, now: number): SessionCountdown | null {
  if (!isLinkUp(snapshot)) return null;
  const { telemetry, telemetryReceivedAt, connectedAt } = snapshot;
  const fresh =
    telemetry && telemetryReceivedAt && (!connectedAt || Date.parse(telemetryReceivedAt) >= Date.parse(connectedAt));
  if (fresh) {
    const elapsed = (now - Date.parse(telemetryReceivedAt!)) / 1000;
    return { seconds: Math.max(0, telemetry!.connectionSecondsLeft - elapsed), source: "telemetry" };
  }
  const deadline = snapshot.estimatedConnectionDeadline
    ? Date.parse(snapshot.estimatedConnectionDeadline)
    : connectedAt
      ? Date.parse(connectedAt) + DEFAULT_CONNECTION_SECONDS * 1000
      : NaN;
  if (Number.isNaN(deadline)) return null;
  return { seconds: Math.max(0, (deadline - now) / 1000), source: "estimate" };
}
