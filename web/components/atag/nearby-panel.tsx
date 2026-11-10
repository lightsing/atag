"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bluetooth,
  BluetoothOff,
  Hand,
  Link2,
  Loader2,
  LockKeyhole,
  MapPin,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { BleConnectionState, TagDevice } from "@/lib/contracts";
import { absoluteTime, formatCountdown, formatMillivolts, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RotationTiming } from "@/lib/workspace/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { KeyProvisioning, type WorkspaceProvisioningProps } from "./key-provisioning";
import {
  Card,
  CommandSentNotice,
  Fact,
  InlineNotice,
  LedSection,
  MaintenanceSection,
  NameSection,
  SettingsSection,
  TelemetrySection,
} from "./nearby-sections";
import { Chip } from "./primitives";
import {
  DEFAULT_CONNECTION_SECONDS,
  sessionCountdown,
  useNearbySession,
  useNow,
  type NearbySession,
  type SessionCountdown,
} from "./use-nearby-session";
import { errorText } from "./workspace-data";

export type NearbyIntent = "manage" | "provision";
type Tab = "status" | "name" | "settings" | "keys" | "maintenance";
const TABS: { id: Tab; label: string }[] = [
  { id: "status", label: "状态" },
  { id: "name", label: "名称" },
  { id: "settings", label: "参数" },
  { id: "keys", label: "密钥" },
  { id: "maintenance", label: "维护" },
];

const STATE_TEXT: Record<BleConnectionState, string> = {
  disconnected: "未连接",
  selecting: "等待在浏览器中选择设备…",
  connecting: "正在连接并读取公开信息…",
  connected: "已连接",
  pairing: "已连接 · 正在加密",
  writing: "已连接 · 正在写入",
};

/** Press highlight lasts this long after the counter changes. */
const PRESS_HIGHLIGHT_MS = 6000;

function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase();
}

interface NearbyPanelProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  intent: NearbyIntent;
  devices: TagDevice[];
  provisioning: WorkspaceProvisioningProps;
  onObserveRotationTiming: ((serial: string, timing: RotationTiming) => Promise<void>) | null;
  onShowDevice(id: string): void;
}

export function NearbyPanel(props: NearbyPanelProps) {
  const { open, intent, devices, onObserveRotationTiming } = props;
  const session = useNearbySession(open);
  const { snapshot, linkUp } = session;
  const now = useNow(open);
  const [tab, setTab] = useState<Tab>("status");
  const [timingError, setTimingError] = useState<string | null>(null);
  const lastTiming = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      setTab(intent === "provision" ? "keys" : "status");
      setTimingError(null);
    }
  }, [open, intent]);

  const writing = session.task === "name" || session.task === "settings" || session.task === "keys" || session.task === "reboot" || session.task === "factory_reset";
  const requestClose = (next: boolean) => {
    if (!next && writing) return; // never abandon an in-flight write silently
    props.onOpenChange(next);
  };

  const countdown = sessionCountdown(snapshot, now);
  const stale = !linkUp && session.everConnected;
  const encrypted = snapshot.encryption === "encrypted" && linkUp;
  const { connectedAt, telemetryReceivedAt, telemetry, settings } = snapshot;
  const serial = telemetry?.chipSerial.toLowerCase();
  const rotation = telemetry?.keyMode === "rotating" && telemetry.flags.encrypted ? telemetry.rotation : 0;
  const interval = settings?.rotation_minutes;
  const coherent = interval !== undefined && Math.min(interval * 60, 0xffffffff) === telemetry?.rotationIntervalSeconds;

  useEffect(() => {
    if (!open || !encrypted || !connectedAt || !telemetryReceivedAt || telemetryReceivedAt < connectedAt ||
        !serial || rotation < 1 || !interval || !coherent || !onObserveRotationTiming ||
        !devices.some((device) => device.chipSerial?.toLowerCase() === serial && device.advertisingMode === "rotating")) return;
    // Telemetry repeats each second. Persist only the first observation of a round per connection and period.
    const key = `${connectedAt}/${serial}/${interval}/${rotation}`;
    if (lastTiming.current === key) return;
    lastTiming.current = key;
    void onObserveRotationTiming(serial, { rotation, observedAt: telemetryReceivedAt, intervalMinutes: interval }).then(
      () => { if (lastTiming.current === key) setTimingError(null); },
      (error) => { if (lastTiming.current === key) setTimingError(errorText(error, "无法保存轮换周期。")); },
    );
  }, [open, encrypted, connectedAt, telemetryReceivedAt, serial, rotation, interval, coherent, devices, onObserveRotationTiming]);

  const hasProtectedData = snapshot.telemetry !== null || snapshot.settings !== null || snapshot.deviceName !== null;
  const showManage = encrypted || (stale && hasProtectedData);
  const unsupported = session.availability !== null && !session.availability.supported;

  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(900px,calc(100dvh-16px))] flex-col gap-0 overflow-hidden rounded-2xl bg-paper p-0 sm:max-w-[620px]"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <DialogTitle className="text-lg">附近管理</DialogTitle>
            <DialogDescription className="mt-1">
              通过浏览器蓝牙直接管理手边的 Tag，不需要本地桥接。
            </DialogDescription>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => requestClose(false)} disabled={writing} aria-label="关闭附近管理">
            <X />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 scrollbar-thin">
          {unsupported ? (
            <Card>
              <div className="flex gap-3">
                <BluetoothOff className="mt-0.5 size-5 shrink-0 text-ink-faint" />
                <div className="text-[13px] leading-relaxed">
                  <p className="font-semibold text-ink">此浏览器无法使用 Web Bluetooth</p>
                  <p className="mt-1 text-ink-soft">{session.availability?.reason ?? "不受支持。"}</p>
                  <p className="mt-1 text-ink-soft">连接、辨认和写入 Tag 需要桌面版 Chrome / Edge 或 Android Chrome，并通过 HTTPS 或 localhost 打开。</p>
                  <p className="mt-1 text-ink-soft">
                    在这里仍可通过“添加设备 → 先创建密钥档案”离线生成密钥并下载加密备份，之后换用支持蓝牙的浏览器恢复备份后写入同一套密钥；已保存的设备和历史也照常可用。
                  </p>
                </div>
              </div>
            </Card>
          ) : (
            <ConnectionCard session={session} countdown={countdown} />
          )}

          {intent === "provision" && !showManage && !unsupported && (
            <InlineNotice tone="info">配置密钥：先连接并辨认 Tag，再启用加密管理，然后在“密钥”页导入配置包并写入。</InlineNotice>
          )}
          {session.notice && <InlineNotice tone={session.notice.tone}>{session.notice.text}</InlineNotice>}
          {timingError && <InlineNotice tone="error">轮换周期未保存到浏览器：{timingError}</InlineNotice>}
          {session.commandSent && <CommandSentNotice sent={session.commandSent} snapshot={snapshot} now={now} />}

          {(linkUp || session.everConnected) && (
            <>
              <IdentityCard session={session} devices={props.devices} stale={stale} onShowDevice={props.onShowDevice} />
              <IdentifyCard session={session} now={now} />
              <EncryptionCard session={session} />
              <LedSection session={session} now={now} stale={stale} />
            </>
          )}

          {showManage && (
            <section aria-label="加密管理" className="space-y-3">
              <div role="tablist" aria-label="管理项目" className="flex gap-0.5 overflow-x-auto rounded-xl bg-muted p-0.5">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "h-8 flex-1 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition-colors",
                      tab === t.id ? "bg-card text-ink shadow-sm" : "text-ink-soft hover:text-ink",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {stale && (
                <InlineNotice tone="warn">连接已断开，以下是断开前读取的数据，不能再保存或发送指令。短按 Tag 后重新连接并启用加密即可继续。</InlineNotice>
              )}
              <div role="tabpanel">
                {tab === "status" && <TelemetrySection session={session} countdown={countdown} stale={stale} />}
                {tab === "name" && <NameSection session={session} />}
                {tab === "settings" && <SettingsSection session={session} now={now} />}
                {tab === "keys" && <KeyProvisioning session={session} provisioning={props.provisioning} />}
                {tab === "maintenance" && <MaintenanceSection session={session} />}
              </div>
            </section>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line bg-card/60 px-5 py-3">
          <p className="flex min-w-0 items-start gap-1.5 text-[11.5px] leading-snug text-ink-faint">
            <MapPin className="mt-0.5 size-3.5 shrink-0" />
            附近管理不读取 GPS 或坐标；远程位置来自 Find My 报告。
          </p>
          <Button variant="outline" size="sm" onClick={() => requestClose(false)} disabled={writing}>
            关闭
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Connection ---------------- */

function ConnectionCard({ session, countdown }: { session: NearbySession; countdown: SessionCountdown | null }) {
  const { snapshot, linkUp } = session;
  const connecting = session.task === "connect" || snapshot.state === "selecting" || snapshot.state === "connecting";
  const title = snapshot.deviceName ?? snapshot.device?.name ?? (session.everConnected ? "已断开的 Tag" : "尚未选择 Tag");
  const estimateLabel = snapshot.settings
    ? `估算值（按参数 ${snapshot.settings.connection_seconds} 秒，从连接建立时计）`
    : `估算值（未取得遥测，按默认 ${DEFAULT_CONNECTION_SECONDS} 秒，从连接建立时计）`;

  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", linkUp ? "bg-ok-wash text-ok" : "bg-muted text-ink-soft")}>
          {connecting ? <Loader2 className="size-5 animate-spin" /> : <Bluetooth className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{title}</p>
          <p role="status" aria-live="polite" className="text-[12.5px] text-ink-soft">
            {STATE_TEXT[snapshot.state]}
            {!linkUp && session.lastDisconnectAt && ` · ${absoluteTime(session.lastDisconnectAt)} 断开`}
          </p>
        </div>
        {countdown && (
          <div className="text-right">
            <p className={cn("font-mono text-[20px] font-semibold tabular-nums leading-none", countdown.seconds <= 15 ? "text-warn" : "text-ink")}>
              {formatCountdown(countdown.seconds)}
            </p>
            <p className="mt-1 text-[11px] text-ink-faint">{countdown.source === "telemetry" ? "剩余 · 设备遥测" : "剩余 · 估算"}</p>
          </div>
        )}
      </div>

      {linkUp && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink-faint">
            {countdown?.source === "estimate" ? estimateLabel : "按设备遥测的剩余秒数推算。"} 按键不会延长连接，到时设备会断开。
          </p>
          <Button size="sm" variant="ghost" onClick={session.disconnect} disabled={session.task === "name" || session.task === "settings" || session.task === "keys"}>
            断开
          </Button>
        </div>
      )}

      {!linkUp && !connecting && (
        <div className="mt-3 space-y-3">
          {!session.everConnected ? (
            <ol className="list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-ink-soft">
              <li>
                <b className="font-medium text-ink">短按你手中 Tag 的按键</b>，打开可连接窗口（默认 60 秒）。未配置的 Tag 每次启动会先自动开一次窗口，结束后才等待按键；已配置的 Tag 短按即可管理，不需要恢复出厂。
              </li>
              <li>
                点击下方按钮，在浏览器列表中选择它。名称是随机的 <span className="font-mono">ATAG-XXXXXXXX</span> 或你设置过的名称；列表只包含提供 ATAG 服务的设备。
              </li>
              <li>连接后先公开辨认（名称、固件、电压、按键），需要修改时再启用加密管理；芯片序列号在加密后读取。</li>
            </ol>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-soft">
              连接已结束。已配置的 Tag 会恢复 Find My 广播，未配置的回到空闲、等待按键。要继续管理，请先<b className="font-medium text-ink">再次短按 Tag</b>，然后重新连接。
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {session.everConnected && snapshot.device && (
              <Button onClick={session.reconnect} disabled={session.busy}>
                <RotateCw /> 重新连接
              </Button>
            )}
            <Button variant={session.everConnected ? "outline" : "default"} onClick={session.pick} disabled={session.busy}>
              <Bluetooth /> {session.everConnected ? "选择其他 Tag" : "选择附近 Tag"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------- Public identity ---------------- */

function IdentityCard({
  session,
  devices,
  stale,
  onShowDevice,
}: {
  session: NearbySession;
  devices: TagDevice[];
  stale: boolean;
  onShowDevice(id: string): void;
}) {
  const { snapshot } = session;
  const id = snapshot.identity;
  // Browsers block standard 2a25: serial stays null until encrypted telemetry supplies it.
  // An unknown serial is never compared with profiles.
  const serial = id?.serial ?? null;
  const linked = serial ? devices.find((d) => d.chipSerial && normalizeSerial(d.chipSerial) === normalizeSerial(serial)) : undefined;
  const refreshingBattery = session.task === "refresh" && snapshot.encryption !== "encrypted";

  return (
    <Card
      title="设备身份与电压"
      aside={
        stale ? <Chip tone="warn">断开前数据</Chip> : <Chip tone="neutral">{serial ? "序列号来自加密遥测" : "无需加密"}</Chip>
      }
    >
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-[13px]">
        <Fact
          label="芯片序列号"
          value={serial ?? (id ? "待加密后读取" : "—")}
          mono={!!serial}
          sub={serial ? "唯一身份，改名或恢复出厂都不变" : "浏览器不能读取公开序列号，加密后从遥测获得"}
        />
        <Fact label="电池 VBAT（实时）" value={formatMillivolts(snapshot.batteryMillivolts)} sub="不换算为百分比" />
        <Fact label="固件" value={id?.firmwareVersion ?? "—"} />
        <Fact label="型号 / 制造商" value={id ? `${id.model} · ${id.manufacturer}` : "—"} />
      </dl>
      {session.linkUp && (
        <Button size="sm" variant="ghost" className="mt-2 -ml-2" onClick={session.refresh} disabled={session.busy}>
          {refreshingBattery ? <Loader2 className="animate-spin" /> : <RefreshCw />} {snapshot.encryption === "encrypted" ? "刷新遥测" : "刷新电压"}
        </Button>
      )}

      <div className="mt-2.5 border-t border-line pt-2.5 text-[12.5px] leading-relaxed">
        {!id ? (
          <p className="text-ink-faint">尚未读取公开信息。</p>
        ) : !serial ? (
          <p className="text-ink-soft">
            序列号待加密后读取。启用加密管理并读到遥测后，才会按序列号与地图档案关联；在此之前不做比较。
          </p>
        ) : linked ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 text-ink">
              <Link2 className="size-3.5 shrink-0 text-ok" />
              序列号匹配我的设备中的档案“<b className="font-semibold">{linked.name}</b>”
              <span className="text-ink-faint">（档案昵称）</span>
            </p>
            <Button size="sm" variant="outline" onClick={() => onShowDevice(linked.id)}>
              <MapPin /> 在地图中查看
            </Button>
          </div>
        ) : (
          <p className="text-ink-soft">
            {devices.length === 0 ? "当前没有设备档案。" : "地图中没有序列号相同的档案。"}
            网页只按芯片序列号关联档案，不会按名称或浏览器设备 ID 自动对应。
          </p>
        )}
        {linked?.latestReport && (
          <p className="mt-1 text-[11.5px] text-ink-faint">
            档案最新位置报告是 {relativeTime(linked.latestReport.observedAt)}，来自 Find My 网络；它与此刻的附近连接无关。
          </p>
        )}
      </div>
    </Card>
  );
}

/* ---------------- Button identification ---------------- */

function IdentifyCard({ session, now }: { session: NearbySession; now: number }) {
  const { snapshot, linkUp } = session;
  const lit = linkUp && !!session.lastPressAt && now - Date.parse(session.lastPressAt) < PRESS_HIGHLIGHT_MS;
  const serial = snapshot.identity?.serial ?? null;
  const currentName = snapshot.deviceName ?? snapshot.device?.name ?? null;

  return (
    <section
      aria-label="辨认按键"
      className={cn(
        "rounded-2xl border p-4 transition-colors duration-300",
        lit ? "border-persimmon bg-persimmon-wash shadow-[0_0_0_3px_var(--persimmon-wash)]" : "border-line bg-card",
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", lit ? "bg-persimmon text-white" : "bg-muted text-ink-soft")}>
          <Hand className={cn("size-5", lit && "motion-safe:animate-bounce")} />
        </span>
        <div className="min-w-0 flex-1" aria-live="polite">
          {lit ? (
            <>
              <p className="text-[15px] font-semibold text-persimmon-ink">收到按键 · 就是这一台</p>
              <p className="mt-0.5 text-[12.5px] text-ink-soft">
                当前连接 <b className="font-semibold text-ink">{currentName ?? "未命名 Tag"}</b>
                {" · "}
                {serial ? (
                  <>
                    序列号 <span className="font-mono text-ink">{serial}</span>
                  </>
                ) : (
                  "序列号待加密后读取"
                )}
              </p>
            </>
          ) : (
            <>
              <p className="text-[14px] font-semibold text-ink">{linkUp ? "短按你手中的 Tag" : "辨认按键"}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-soft">
                {linkUp
                  ? "按下后这里会高亮，确认当前连接的就是你手里那台。连接时读到的计数只是基线，不算按键。"
                  : "连接后可用。"}
              </p>
            </>
          )}
          {session.pressCount > 0 && (
            <p className="mt-1 text-[11.5px] text-ink-faint">
              本次连接收到 {session.pressCount} 次按键
              {session.lastPressAt && ` · 最近 ${absoluteTime(session.lastPressAt)}`}
              {snapshot.buttonCounter !== null && ` · 设备计数 ${snapshot.buttonCounter}`}
            </p>
          )}
        </div>
      </div>
      <p className="mt-2.5 text-[11.5px] text-ink-faint">按键只上报计数，不会延长连接时间。</p>
    </section>
  );
}

/* ---------------- Encryption ---------------- */

function EncryptionCard({ session }: { session: NearbySession }) {
  const { snapshot, linkUp } = session;
  const encrypted = snapshot.encryption === "encrypted";
  // Only state 2 (encrypted) is ready; an adapter-reported "pairing" is still pending.
  const pairingTask = session.task === "pair" || snapshot.encryption === "pairing";
  const loadingProtected = (pairingTask && encrypted) || session.task === "load";

  if (!linkUp) {
    return null;
  }

  if (encrypted && !pairingTask) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ok">
            <ShieldCheck className="size-4" /> 加密管理已就绪
          </p>
          <span className="text-[11.5px] text-ink-faint">Just Works · 仅本次连接有效</span>
        </div>
        {session.protectedErrors.length > 0 && (
          <div className="mt-2.5 space-y-2">
            <InlineNotice tone="error">
              {session.protectedErrors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </InlineNotice>
            <Button size="sm" variant="outline" onClick={session.reloadProtected} disabled={session.busy}>
              <RotateCw /> 重新读取
            </Button>
          </div>
        )}
        {loadingProtected && (
          <p className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-soft">
            <Loader2 className="size-3.5 animate-spin" /> 正在依次读取名称、参数和遥测…
          </p>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-ink-soft">
          {pairingTask ? <Loader2 className="size-5 animate-spin" /> : <LockKeyhole className="size-5" />}
        </span>
        <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed">
          {pairingTask ? (
            encrypted ? (
              <>
                <p className="text-[14px] font-semibold text-ink">已加密，正在读取</p>
                <p className="text-ink-soft">正在依次读取名称、参数和遥测…</p>
              </>
            ) : (
              <>
                <p className="text-[14px] font-semibold text-ink">正在请求加密…</p>
                <p className="text-ink-soft">如果系统弹出蓝牙配对确认，请选择“配对 / 允许”。无需输入 PIN。设备回报“已加密”前不会访问受保护内容。</p>
              </>
            )
          ) : (
            <>
              <p className="text-[14px] font-semibold text-ink">启用加密管理</p>
              <p className="text-ink-soft">
                修改名称、运行参数、读取完整遥测、配置密钥以及重启 / 恢复出厂都需要加密链路。采用 Just Works：无 PIN、无中间人防护，系统可能弹出确认；不保存绑定，连接结束即失效。
              </p>
            </>
          )}
          {session.pairingError && !pairingTask && (
            <p role="alert" className="mt-2 rounded-lg bg-danger-wash px-3 py-2 text-danger">
              加密未就绪：{session.pairingError} 如果拒绝了系统配对或连接已超时，可以重试；连接断开时请先短按 Tag 重新连接。
            </p>
          )}
          {!pairingTask && (
            <Button size="sm" className="mt-2.5" onClick={session.enableEncryption} disabled={session.busy}>
              <LockKeyhole /> {session.pairingError ? "重试加密" : "启用加密管理"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
