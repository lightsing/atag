"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Bluetooth, Plus, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { loadPreferences, savePreferences, type Preferences } from "@/lib/preferences";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { DeviceDetail, type FetchReadiness } from "./device-detail";
import { DeleteDeviceDialog, EditDeviceDialog } from "./device-dialogs";
import { DeviceList, sortDevices, type SortOrder } from "./device-list";
import { DeviceMap, type MapInsets } from "./device-map";
import { NearbyPanel, type NearbyIntent } from "./nearby-panel";
import { BrandMark, Chip } from "./primitives";
import { SettingsSheet, type SettingsFocus } from "./settings-sheet";
import { SetupWizard } from "./setup-wizard";
import { useAtagSession, type AtagSession, type RefreshTask } from "./use-atag-session";
import { useReports, type HistoryRange } from "./use-reports";

const DESKTOP_QUERY = "(min-width: 1024px)";

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(DESKTOP_QUERY);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

function useViewportHeight(): number {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener("resize", notify);
      return () => window.removeEventListener("resize", notify);
    },
    () => window.innerHeight,
    () => 800,
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function SourceStatus({ session, onClick, compact = false }: { session: AtagSession; onClick(): void; compact?: boolean }) {
  const { bridge } = session;
  let chip: React.ReactNode;
  if (session.storageError) chip = <Chip tone="danger" dot>{compact ? "存储不可用" : "此浏览器存储不可用"}</Chip>;
  else chip = <Chip tone="neutral">{compact ? "此浏览器" : "我的设备 · 此浏览器"}</Chip>;
  // Bridge state only matters for sign-in and fetching fresh reports; shown as a secondary hint.
  let bridgeChip: React.ReactNode = null;
  if (!compact) {
    if (bridge.status === "connected") bridgeChip = session.auth?.status === "ready" ? <Chip tone="ok" dot>可刷新</Chip> : <Chip tone="accent" dot>桥接已连接</Chip>;
    else if (bridge.status === "connecting") bridgeChip = <Chip tone="accent" dot>{bridge.phase === "permission" ? "等待本地网络权限" : "连接桥接"}</Chip>;
    else if (bridge.status === "error") bridgeChip = <Chip tone="warn" dot>桥接失败</Chip>;
  }
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 rounded-full" aria-label="数据与刷新状态，打开设置">
      {chip}
      {bridgeChip}
    </button>
  );
}

export function AtagApp() {
  const session = useAtagSession();
  const isDesktop = useIsDesktop();
  const viewportHeight = useViewportHeight();

  const [prefs, setPrefs] = useState<Preferences>(() => ({ agentUrl: "", anisetteUrl: "", clientProfile: "auto", sort: "recent" }));
  useEffect(() => setPrefs(loadPreferences()), []);
  const updatePrefs = useCallback((patch: Partial<Preferences>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePreferences(next);
      return next;
    });
  }, []);

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState<HistoryRange>("24h");
  const [focusedReportId, setFocusedReportId] = useState<string | null>(null);
  const [reportsRetry, setReportsRetry] = useState(0);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [nearbyIntent, setNearbyIntent] = useState<NearbyIntent>("manage");
  const [nearbyProfileId, setNearbyProfileId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { devices, client } = session;
  const selected = useMemo(() => devices.find((d) => d.id === selectedId) ?? null, [devices, selectedId]);
  const reports = useReports(client, selected?.id ?? null, range, session.reportsVersion, reportsRetry);

  // Auto-select the most recent device once (desktop); drop deleted ones.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (session.devicesState !== "ready") return;
    if (selectedId && !devices.some((d) => d.id === selectedId)) {
      setSelectedId(null);
      setMobileView("list");
      return;
    }
    if (!autoSelectedRef.current && !selectedId && isDesktop && devices.length > 0) {
      autoSelectedRef.current = true;
      const first = sortDevices(devices, "recent")[0];
      if (first?.latestReport) setSelectedId(first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, session.devicesState]);

  useEffect(() => setFocusedReportId(null), [selectedId, range]);

  // Toast when a refresh task finishes, even if its detail panel is closed.
  const previousTasks = useRef<Record<string, RefreshTask>>({});
  useEffect(() => {
    for (const [id, task] of Object.entries(session.refreshTasks)) {
      const before = previousTasks.current[id];
      if (before?.status !== "running" || task.status === "running") continue;
      const name = devices.find((d) => d.id === id)?.name ?? "设备";
      if (task.status === "done") {
        if (task.newReportCount > 0) {
          toast.success(`${name}：收到 ${task.newReportCount} 条新报告`);
        } else {
          toast(`${name}：暂无新报告`);
        }
      } else if (task.status === "failed" && task.error.code !== "CANCELLED") {
        toast.error(`${name}：刷新失败`, { description: task.error.message });
      }
    }
    previousTasks.current = session.refreshTasks;
  }, [session.refreshTasks, devices]);

  const selectDevice = useCallback((id: string) => {
    setSelectedId(id);
    setMobileView("detail");
  }, []);

  const closeDetail = useCallback(() => {
    if (isDesktop) setSelectedId(null);
    setMobileView("list");
  }, [isDesktop]);

  const onCopy = useCallback(async (text: string) => {
    const ok = await copyText(text);
    if (!ok) toast.error("复制失败", { description: "浏览器不允许访问剪贴板，请手动选择坐标。" });
    return ok;
  }, []);

  const openSettings = useCallback((focus: SettingsFocus | null = null) => {
    setSettingsFocus(focus);
    setSettingsOpen(true);
  }, []);
  const openWizard = useCallback(() => setWizardOpen(true), []);
  const openNearby = useCallback((intent: NearbyIntent = "manage", profileId: string | null = null) => {
    setNearbyIntent(intent);
    setNearbyProfileId(profileId);
    setNearbyOpen(true);
  }, []);

  const storageOk = session.workspaceReady && !session.storageError;
  const fetchReadiness: FetchReadiness = {
    bridgeConnected: session.bridge.status === "connected",
    account: session.auth?.status === "ready" ? "ready" : session.auth?.status === "expired" ? "expired" : "missing",
  };

  const track = selected ? reports.reports : [];

  const sheetHeight = Math.round(viewportHeight * (sheetExpanded ? 0.86 : 0.46));
  const insets: MapInsets = isDesktop
    ? { top: 0, right: selected ? 416 : 0, bottom: 0, left: 0 }
    : { top: 72, right: 0, bottom: sheetHeight, left: 0 };

  const list = (
    <DeviceList
      devices={devices}
      devicesState={session.devicesState}
      devicesError={session.devicesError}
      selectedId={selectedId}
      query={query}
      sort={prefs.sort}
      refreshTasks={session.refreshTasks}
      onQueryChange={setQuery}
      onSortChange={(sort: SortOrder) => updatePrefs({ sort })}
      onSelect={selectDevice}
      onRetry={() => void session.reloadDevices()}
      onOpenData={() => openSettings("data")}
      onAddDevice={openWizard}
    />
  );

  const detail = selected ? (
    <DeviceDetail
      device={selected}
      fetchReadiness={fetchReadiness}
      reports={reports}
      range={range}
      focusedReportId={focusedReportId}
      refreshTask={session.refreshTasks[selected.id]}
      backLabel={isDesktop ? "close" : "back"}
      onRangeChange={setRange}
      onFocusReport={setFocusedReportId}
      onRefresh={() => session.refreshReports(selected.id)}
      onRetryReports={() => setReportsRetry((n) => n + 1)}
      onEdit={() => setEditOpen(true)}
      onDelete={() => setDeleteOpen(true)}
      onClose={closeDetail}
      onCopy={onCopy}
      onOpenNearby={() => openNearby()}
      onConfigure={() => openNearby("provision", selected.id)}
      onOpenBridgeSettings={() => openSettings(fetchReadiness.bridgeConnected ? "apple" : "bridge")}
      queryRevision={session.reportsVersion}
      onLoadQuerySettings={session.getQuerySettings}
      onSaveQuerySettings={session.updateQuerySettings}
    />
  ) : null;

  const map = (
    <DeviceMap
      devices={devices}
      selectedId={selectedId}
      track={track}
      focusedReportId={focusedReportId}
      onSelectDevice={(id) => {
        selectDevice(id);
      }}
      onFocusReport={(id) => setFocusedReportId(id === selected?.latestReport?.id ? null : id)}
      insets={insets}
    />
  );

  return (
    <>
      {isDesktop ? (
        <div className="flex h-dvh overflow-hidden bg-paper text-ink">
          <aside className="flex w-[340px] shrink-0 flex-col border-r border-line xl:w-[360px]" aria-label="设备列表">
            <header className="flex items-center gap-2.5 px-4 pb-3 pt-4">
              <BrandMark className="size-8" />
              <div className="min-w-0 flex-1">
                <h1 className="text-[17px] font-semibold leading-tight tracking-tight">我的 ATAG</h1>
                <p className="text-[12px] text-ink-faint">Find My 报告 · 附近蓝牙管理</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => openSettings()} aria-label="设置" title="设置">
                <Settings2 />
              </Button>
            </header>
            <div className="flex items-center justify-between gap-2 px-4 pb-2">
              <SourceStatus session={session} onClick={() => openSettings()} />
              {devices.length > 0 && <span className="text-[12px] text-ink-faint">{devices.length} 台设备</span>}
            </div>
            {list}
            <div className="grid grid-cols-2 gap-2 border-t border-line p-3">
              <Button onClick={() => openNearby()} className="bg-persimmon text-white hover:bg-persimmon-ink">
                <Bluetooth /> 附近管理
              </Button>
              <Button onClick={openWizard} variant="outline" className="bg-card">
                <Plus /> 添加设备
              </Button>
            </div>
          </aside>

          <main className="relative min-w-0 flex-1">
            {map}
            {detail && (
              <div className="absolute bottom-3 right-3 top-3 z-20 w-[400px] overflow-y-auto rounded-2xl border border-line bg-paper/[0.98] shadow-[0_20px_50px_-12px_rgb(31_28_24/0.28)] scrollbar-thin">
                {detail}
              </div>
            )}
          </main>
        </div>
      ) : (
        <div className="relative h-dvh overflow-hidden bg-paper text-ink">
          <div className="absolute inset-0">{map}</div>

          <header className="absolute inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-20 flex items-center gap-2 rounded-2xl border border-line bg-card/95 py-1.5 pl-2 pr-1.5 shadow-md backdrop-blur">
            <BrandMark className="size-7" />
            <h1 className="text-[15px] font-semibold tracking-tight">我的 ATAG</h1>
            <div className="ml-auto flex items-center gap-1">
              <SourceStatus session={session} onClick={() => openSettings()} compact />
              <Button variant="ghost" size="icon" onClick={() => openNearby()} aria-label="附近管理" title="附近管理">
                <Bluetooth />
              </Button>
              <Button variant="ghost" size="icon" onClick={openWizard} aria-label="添加设备">
                <Plus />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => openSettings()} aria-label="设置">
                <Settings2 />
              </Button>
            </div>
          </header>

          <section
            aria-label={mobileView === "detail" && selected ? "设备详情" : "设备列表"}
            className="absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-3xl border-t border-line bg-paper shadow-[0_-12px_40px_-12px_rgb(31_28_24/0.3)] transition-[height] duration-300 ease-out"
            style={{ height: sheetHeight }}
          >
            <button
              type="button"
              onClick={() => setSheetExpanded((v) => !v)}
              aria-expanded={sheetExpanded}
              aria-label={sheetExpanded ? "收起面板" : "展开面板"}
              className="flex h-7 shrink-0 items-center justify-center text-ink-faint"
            >
              <span className="h-1 w-10 rounded-full bg-input" />
            </button>
            {mobileView === "detail" && detail ? (
              <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)] scrollbar-thin">{detail}</div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
                <div className="flex items-center justify-between px-4 pb-2">
                  <h2 className="text-[15px] font-semibold">设备</h2>
                </div>
                {list}
              </div>
            )}
          </section>
        </div>
      )}

      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        side={isDesktop ? "right" : "bottom"}
        focus={settingsFocus}
        session={session}
        agentUrl={prefs.agentUrl || ""}
        onAgentUrlChange={(agentUrl) => updatePrefs({ agentUrl })}
        anisetteUrl={prefs.anisetteUrl}
        onAnisetteUrlChange={(anisetteUrl) => updatePrefs({ anisetteUrl })}
        clientProfile={prefs.clientProfile}
        onClientProfileChange={(clientProfile) => updatePrefs({ clientProfile })}
        onConnect={async (url) => {
          const ok = await session.connectBridge(url);
          if (ok)
            toast.success("已连接本地桥接", {
              description: session.auth?.status === "ready" ? "可以下载 Find My 报告。" : "现在可以登录 Apple 账号。",
            });
          return ok;
        }}
      />

      <SetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onOpenData={() => openSettings("data")}
        createBundle={storageOk ? session.createProvisioningBundle : null}
        onConfigureProfile={(id) => openNearby("provision", id)}
        onStartNearby={() => openNearby("provision")}
      />

      <NearbyPanel
        open={nearbyOpen}
        onOpenChange={setNearbyOpen}
        intent={nearbyIntent}
        devices={devices}
        onObserveRotationTiming={storageOk ? session.observeRotationTiming : null}
        provisioning={{
          createBundle: storageOk ? session.createProvisioningBundle : null,
          getBundle: storageOk ? session.getProvisioningBundle : null,
          listProfiles: storageOk ? session.listWorkspaceDevices : null,
          preferredProfileId: nearbyProfileId,
          confirmProvisioning: session.confirmProvisioning,
          onOpenBackup: () => openSettings("data"),
        }}
        onShowDevice={(id) => {
          setNearbyOpen(false);
          selectDevice(id);
        }}
      />

      <EditDeviceDialog
        device={selected}
        open={editOpen && !!selected}
        onOpenChange={setEditOpen}
        onSave={async (patch) => {
          if (!selected) return;
          await session.updateDevice(selected.id, patch);
          toast.success("已保存");
        }}
      />

      <DeleteDeviceDialog
        device={selected}
        open={deleteOpen && !!selected}
        onOpenChange={setDeleteOpen}
        onConfirm={async () => {
          if (!selected) return;
          const name = selected.name;
          await session.deleteDevice(selected.id);
          setSelectedId(null);
          setMobileView("list");
          toast(`已删除“${name}”的档案`, { description: "已从此浏览器删除；物理 tag 未被擦除。" });
        }}
      />

      <Toaster theme="light" position={isDesktop ? "bottom-center" : "top-center"} offset={isDesktop ? 24 : 80} />
    </>
  );
}
