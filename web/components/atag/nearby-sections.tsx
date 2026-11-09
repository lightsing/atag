"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Lightbulb,
  Loader2,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  Undo2,
  XCircle,
} from "lucide-react";
import type { BleSessionSnapshot, BleTelemetry, TagSettings } from "@/lib/contracts";
import {
  DEFAULT_SETTINGS,
  SETTING_LIMITS,
  TX_POWER_VALUES,
  validateDeviceName,
  validateSettings,
} from "@/lib/ble/settings-protocol";
import { absoluteTime, describeResetReason, formatCountdown, formatDuration, formatMillivolts, formatRotation } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Chip } from "./primitives";
import {
  LED_REJECT_TEXT,
  ledHardware,
  type CommandSent,
  type CommitOutcome,
  type LedHardware,
  type LedOutcome,
  type NearbySession,
  type SessionCountdown,
} from "./use-nearby-session";

/* ---------------- Shared bits ---------------- */

export function Card({ title, aside, children, className }: { title?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-line bg-card p-4", className)}>
      {(title || aside) && (
        <div className="mb-2.5 flex items-center justify-between gap-2">
          {title && <h3 className="text-[14px] font-semibold text-ink">{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Fact({ label, value, sub, mono, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; mono?: boolean; tone?: "warn" | "ok" | "muted" }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-faint">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 break-words tabular-nums",
          mono && "font-mono text-[12.5px]",
          tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : tone === "muted" ? "text-ink-faint" : "text-ink",
        )}
      >
        {value}
      </dd>
      {sub && <dd className="text-[11.5px] leading-snug text-ink-faint">{sub}</dd>}
    </div>
  );
}

export function InlineNotice({ tone, children }: { tone: "info" | "error" | "warn" | "ok"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-2 rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed",
        tone === "error" && "bg-danger-wash text-danger",
        tone === "warn" && "bg-warn-wash text-warn",
        tone === "ok" && "bg-ok-wash text-ok",
        tone === "info" && "bg-muted text-ink-soft",
      )}
    >
      {tone === "error" ? (
        <XCircle className="mt-0.5 size-4 shrink-0" />
      ) : tone === "ok" ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Persistent result for name / settings / keys commits. */
export function OutcomeNotice({ outcome, what }: { outcome: CommitOutcome; what: string }) {
  if (outcome.kind === "committed") {
    return (
      <InlineNotice tone="ok">
        {what}已保存到 Flash（设备回执 commit 确认，{absoluteTime(outcome.at)}）
      </InlineNotice>
    );
  }
  if (outcome.kind === "rejected") {
    return (
      <InlineNotice tone="error">
        设备拒绝了{what}（结果码 {outcome.status.resultCode}，原因码 {outcome.status.errorCode}），未保存任何内容。
      </InlineNotice>
    );
  }
  if (outcome.kind === "not_sent") {
    return <InlineNotice tone="error">未发送：{outcome.message}</InlineNotice>;
  }
  return (
    <InlineNotice tone="warn">
      {what}结果未知：{outcome.message} 没有收到本次操作的 commit 回执，不能认为已保存；重新连接并加密后读取当前值核对。
    </InlineNotice>
  );
}

/* ---------------- Telemetry ---------------- */

const PHASE_TEXT: Record<BleTelemetry["phase"], string> = {
  idle: "空闲（等待按键）",
  broadcasting: "Find My 广播",
  advertising: "等待连接",
  connected: "已连接管理",
};

export function TelemetrySection({
  session,
  countdown,
  stale,
}: {
  session: NearbySession;
  countdown: SessionCountdown | null;
  stale: boolean;
}) {
  const { snapshot } = session;
  const t = snapshot.telemetry;
  const refreshing = session.task === "refresh";
  return (
    <Card
      title="设备状态"
      aside={
        <Button size="sm" variant="ghost" onClick={session.refresh} disabled={session.busy || !session.linkUp}>
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />} 刷新
        </Button>
      }
    >
      {!t ? (
        <p className="text-[13px] text-ink-soft">尚未读取遥测。</p>
      ) : (
        <>
          {stale && <p className="mb-2 text-[12px] text-warn">连接已断开，以下为断开前最后一次遥测，不是实时状态。</p>}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-[13px]">
            <Fact label="电池 VBAT" value={formatMillivolts(t.batteryMillivolts)} sub="电池端电压，已按校准系数修正" />
            <Fact label="芯片 VDD" value={formatMillivolts(t.supplyMillivolts)} sub="芯片供电电压" />
            <Fact
              label="低电压标志"
              value={t.flags.lowVoltage ? "已置位" : "未置位"}
              tone={t.flags.lowVoltage ? "warn" : undefined}
              sub={`≤ ${t.batteryLowMillivolts} mV 置位，≥ ${t.batteryRecoveryMillivolts} mV 清除`}
            />
            <Fact
              label="连接剩余"
              value={countdown ? formatCountdown(countdown.seconds) : "—"}
              sub={countdown ? (countdown.source === "telemetry" ? "按设备遥测推算" : "估算值") : "未连接"}
            />
            <Fact label="密钥" value={formatRotation(t.keyMode, null)} tone={t.keyMode === "unset" ? "warn" : undefined} />
            <Fact
              label="轮次"
              value={t.keyMode === "rotating" ? `第 ${t.rotation} 轮` : t.keyMode === "fixed" ? "固定（不轮换）" : "—"}
              sub={t.keyMode === "rotating" ? `周期 ${formatDuration(t.rotationIntervalSeconds)}` : undefined}
            />
          </dl>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
            低电压标志只是指示，实际断电与恢复由电池保护电路负责。管理连接期间暂停 Find My 广播，轮换轮次仍按时间推进。遥测由连接自动订阅，约每秒更新。
            {snapshot.telemetryReceivedAt && ` 最近更新 ${absoluteTime(snapshot.telemetryReceivedAt)}。`}
          </p>
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="group flex items-center gap-1 text-[12.5px] font-medium text-ink-soft hover:text-ink">
              <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" /> 技术细节
            </CollapsibleTrigger>
            <CollapsibleContent>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl bg-muted/60 px-3 py-2.5 text-[12.5px]">
                <Fact label="阶段" value={PHASE_TEXT[t.phase]} />
                <Fact label="运行时间" value={formatDuration(t.uptimeSeconds)} />
                <Fact label="复位原因" value={describeResetReason(t.resetReason)} />
                <Fact label="芯片序列号" value={t.chipSerial} mono />
                <Fact label="低频时钟" value={t.flags.externalClock ? "外部 32.768 kHz 晶振" : "内部 RC"} />
                <Fact label="电源" value={t.flags.dcdc ? "DC/DC" : "LDO"} />
                <Fact label="链路加密" value={t.flags.encrypted ? "已加密" : "未加密"} />
                <Fact label="nRESET 引脚" value={t.flags.resetPin ? "已启用" : "未启用"} />
                <Fact label="按键" value={t.flags.buttonHeld ? "按住中" : "未按住"} />
                <Fact label="等待连接窗口剩余" value={`${t.advertisingSecondsLeft} 秒`} />
                <Fact label="连接剩余（遥测原值）" value={`${t.connectionSecondsLeft} 秒`} />
                <Fact label="遥测版本" value={`v${t.version}`} />
              </dl>
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </Card>
  );
}

/* ---------------- Name ---------------- */

const NAME_MAX_BYTES = 29;

export function NameSection({ session }: { session: NearbySession }) {
  const current = session.snapshot.deviceName;
  const [draft, setDraft] = useState(current ?? "");
  const [base, setBase] = useState(current);
  if (current !== base) {
    // Device value changed (load or commit): follow it unless the user is mid-edit.
    if (draft === (base ?? "")) setDraft(current ?? "");
    setBase(current);
  }
  const check = validateDeviceName(draft);
  const unchanged = draft === (current ?? "");
  const saving = session.task === "name";
  const advertised = session.snapshot.device?.name;

  return (
    <Card title="设备名称">
      <p className="mb-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        写入 tag 本身、在蓝牙选择器中显示的名称，与“我的设备”中的档案昵称分开保存。支持中文，限制按 UTF-8 字节计算。
      </p>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (check.valid && !unchanged) void session.saveName(draft);
        }}
      >
        <label className="grid gap-1 text-[12.5px]">
          <span className="flex items-center justify-between font-medium">
            名称
            <span aria-live="polite" className={cn("tabular-nums", check.byteLength > NAME_MAX_BYTES ? "text-danger" : "text-ink-faint")}>
              {check.byteLength} / {NAME_MAX_BYTES} 字节
            </span>
          </span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving || current === null}
            aria-invalid={!check.valid}
            placeholder={current === null ? "尚未读取" : undefined}
            className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-persimmon aria-[invalid=true]:border-danger"
          />
        </label>
        {!check.valid && draft !== "" && <p className="text-[12px] text-danger">{check.error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={!check.valid || unchanged || session.busy || !session.linkUp}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {saving ? "等待 commit 回执…" : "保存名称"}
          </Button>
          {!unchanged && (
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(current ?? "")}>
              <Undo2 /> 还原
            </Button>
          )}
        </div>
      </form>
      {session.nameOutcome && (
        <div className="mt-2.5">
          <OutcomeNotice outcome={session.nameOutcome} what="名称" />
        </div>
      )}
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
        芯片序列号不会因改名而变化，身份关联始终以序列号为准。
        {advertised && advertised !== current && current !== null && (
          <> 浏览器选择器显示的“{advertised}”可能是系统缓存的旧广播名，以这里读取的名称为准。</>
        )}
      </p>
    </Card>
  );
}

/* ---------------- Settings ---------------- */

type SettingKey = Exclude<keyof TagSettings, "led_enabled">;
type Group = "basic" | "connection" | "battery";
interface FieldMeta {
  key: SettingKey;
  label: string;
  unit: string;
  help: string;
  group: Group;
}

const FIELDS: FieldMeta[] = [
  { key: "advertising_interval_ms", label: "Find My 广播间隔", unit: "毫秒", group: "basic", help: "已配置设备离线查找广播的间隔。越短越容易被发现，也越耗电。" },
  { key: "tx_power_dbm", label: "发射功率", unit: "dBm", group: "basic", help: "保存后立即作用于当前会话及之后的广播。" },
  { key: "rotation_minutes", label: "密钥轮换周期", unit: "分钟", group: "basic", help: "仅轮换模式使用。从保存时刻开始新周期，不重新生成密钥，也不重置轮次。" },
  { key: "gatt_advertising_seconds", label: "等待连接窗口", unit: "秒", group: "connection", help: "短按或未配置设备上电后可被连接的时长。下一次打开窗口时生效。" },
  { key: "gatt_interval_ms", label: "可连接广播间隔", unit: "毫秒", group: "connection", help: "等待连接期间的广播间隔。下一次打开窗口时生效。" },
  { key: "connection_seconds", label: "连接时限", unit: "秒", group: "connection", help: "从连接建立时开始计时，按键不会续时。保存后当前连接按原连接时间重算。" },
  { key: "reset_hold_seconds", label: "恢复出厂长按时长", unit: "秒", group: "connection", help: "按住按键达到此时长会清空名称、参数和密钥。在按下的那一刻读取。" },
  { key: "battery_low_mv", label: "低电压标志阈值", unit: "mV", group: "battery", help: "电压不高于此值时置低压标志。仅为指示，断电由电池保护电路负责。" },
  { key: "battery_recovery_mv", label: "低电压恢复阈值", unit: "mV", group: "battery", help: "电压不低于此值时清除低压标志，必须大于低电压阈值。" },
  { key: "battery_idle_seconds", label: "未连接时电压采样间隔", unit: "秒", group: "battery", help: "未处于管理连接时测量电压的周期。" },
  { key: "battery_gatt_seconds", label: "连接时电压采样间隔", unit: "秒", group: "battery", help: "管理连接期间测量电压的周期。" },
  { key: "battery_calibration_ppm", label: "VBAT 校准", unit: "ppm", group: "battery", help: "VBAT × (1 000 000 + ppm) / 1 000 000。" },
];

const GROUPS: { id: Group; title: string; note?: string }[] = [
  { id: "basic", title: "Find My 广播" },
  { id: "connection", title: "连接与按键" },
  { id: "battery", title: "电池（高级）", note: "电压指示阈值与采样设置，一般无需修改。" },
];

type Draft = Record<SettingKey, string> & { led_enabled: boolean };

function toDraft(settings: TagSettings): Draft {
  return { ...Object.fromEntries(FIELDS.map((f) => [f.key, String(settings[f.key])])), led_enabled: settings.led_enabled } as Draft;
}

function parseDraft(draft: Draft): { values: Partial<TagSettings>; errors: Partial<Record<SettingKey, string>> } {
  const values: Partial<TagSettings> = { led_enabled: draft.led_enabled };
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const f of FIELDS) {
    const raw = draft[f.key].trim();
    if (!/^-?\d+$/.test(raw)) {
      errors[f.key] = "请输入整数";
      continue;
    }
    const n = Number(raw);
    if (f.key === "tx_power_dbm") {
      if (!TX_POWER_VALUES.includes(n)) errors[f.key] = "不支持的功率档位";
    } else {
      const [min, max] = SETTING_LIMITS[f.key];
      if (n < min || n > max) errors[f.key] = `范围 ${min.toLocaleString("zh-CN")}～${max.toLocaleString("zh-CN")}`;
    }
    values[f.key] = n;
  }
  if (!errors.battery_low_mv && !errors.battery_recovery_mv && values.battery_low_mv! >= values.battery_recovery_mv!) {
    errors.battery_low_mv = "必须小于恢复阈值";
    errors.battery_recovery_mv = "必须大于低电压阈值";
  }
  return { values, errors };
}

export function SettingsSection({ session, now }: { session: NearbySession; now: number }) {
  const current = session.snapshot.settings;
  const [draft, setDraft] = useState<Draft | null>(current ? toDraft(current) : null);
  const [base, setBase] = useState<TagSettings | null>(current);
  const [batteryOpen, setBatteryOpen] = useState(false);
  /** LED permission included in the last save attempt; null when it was unchanged. */
  const [savedLedChange, setSavedLedChange] = useState<boolean | null>(null);

  const dirtyKeys = useMemo(
    () => (draft && base ? FIELDS.filter((f) => draft[f.key].trim() !== String(base[f.key])).map((f) => f.key) : []),
    [draft, base],
  );
  const ledDirty = !!draft && !!base && draft.led_enabled !== base.led_enabled;
  if (current !== base) {
    // Follow fresh device values (initial read, commit) unless the user has unsaved edits.
    if (!draft || (dirtyKeys.length === 0 && !ledDirty)) setDraft(current ? toDraft(current) : null);
    setBase(current);
  }

  const parsed = useMemo(() => (draft ? parseDraft(draft) : null), [draft]);
  const fieldErrors = parsed?.errors ?? {};
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  const candidate = !hasFieldErrors && parsed ? (parsed.values as TagSettings) : null;
  const globalErrors = candidate ? validateSettings(candidate) : [];
  const saving = session.task === "settings";

  useEffect(() => {
    if (FIELDS.some((f) => f.group === "battery" && (fieldErrors[f.key] || dirtyKeys.includes(f.key)))) setBatteryOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFieldErrors, dirtyKeys.length]);

  if (!current || !draft) {
    return (
      <Card title="运行参数">
        <p className="text-[13px] text-ink-soft">需要先读取设备当前参数，再在其基础上编辑。不会用默认值覆盖设备。</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={session.reloadProtected} disabled={session.busy || !session.linkUp}>
          {session.task === "load" ? <Loader2 className="animate-spin" /> : <RefreshCw />} 读取参数
        </Button>
      </Card>
    );
  }

  const connectedAt = session.snapshot.connectedAt ? Date.parse(session.snapshot.connectedAt) : null;
  let shortenWarning: string | null = null;
  if (candidate && connectedAt && candidate.connection_seconds < current.connection_seconds) {
    const left = Math.floor((connectedAt + candidate.connection_seconds * 1000 - now) / 1000);
    shortenWarning =
      left <= 0
        ? `本次连接已持续 ${Math.floor((now - connectedAt) / 1000)} 秒，超过新的 ${candidate.connection_seconds} 秒时限：设备发出保存回执后会立即断开。`
        : `连接时限按原连接时间重算，保存后本次连接约剩 ${left} 秒。`;
  }
  const nextWindowChanged = dirtyKeys.some((k) => k === "gatt_advertising_seconds" || k === "gatt_interval_ms");
  const hardware = ledHardware(session.snapshot);
  // Telemetry may outlive encryption loss, so the switch also requires the link to be encrypted right now.
  const ledEncrypted = session.linkUp && session.snapshot.encryption === "encrypted";
  const ledToggleEnabled = hardware === "present" && ledEncrypted && !session.busy;
  const changedCount = dirtyKeys.length + (ledDirty ? 1 : 0);
  const canSave =
    !!candidate && globalErrors.length === 0 && changedCount > 0 && !session.busy && session.linkUp && (!candidate.led_enabled || hardware === "present");

  const renderField = (f: FieldMeta) => {
    const error = fieldErrors[f.key];
    const dirty = dirtyKeys.includes(f.key);
    const id = `setting-${f.key}`;
    const limits = f.key === "tx_power_dbm" ? null : SETTING_LIMITS[f.key];
    return (
      <div key={f.key} className="grid gap-1 text-[12.5px]">
        <label htmlFor={id} className="flex items-center justify-between gap-2 font-medium">
          <span>
            {f.label}
            {dirty && <span className="ml-1.5 text-[11px] font-normal text-persimmon-ink">已修改 · 原 {String(current[f.key])}</span>}
          </span>
          <span className="font-normal text-ink-faint">{f.unit}</span>
        </label>
        {f.key === "tx_power_dbm" ? (
          <select
            id={id}
            value={draft[f.key]}
            disabled={saving}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
          >
            {TX_POWER_VALUES.map((v) => (
              <option key={v} value={String(v)}>
                {v > 0 ? `+${v}` : v} dBm
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            inputMode="numeric"
            value={draft[f.key]}
            disabled={saving}
            aria-invalid={!!error}
            aria-describedby={`${id}-help`}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
            className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm tabular-nums outline-none focus-visible:border-persimmon aria-[invalid=true]:border-danger"
          />
        )}
        <p id={`${id}-help`} className={cn("leading-snug", error ? "text-danger" : "text-ink-faint")}>
          {error ?? f.help}
          {!error && limits && <span className="ml-1 whitespace-nowrap">（{limits[0].toLocaleString("zh-CN")}～{limits[1].toLocaleString("zh-CN")}）</span>}
        </p>
      </div>
    );
  };

  return (
    <Card title="运行参数">
      <p className="mb-3 text-[12.5px] leading-relaxed text-ink-soft">
        以设备当前参数为底稿编辑，保存时写入完整的 64 字节设置包，并等待设备的 commit 回执。修改轮换周期不会重新生成密钥。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSave || !candidate) return;
          setSavedLedChange(ledDirty ? candidate.led_enabled : null);
          void session.saveSettings(candidate);
        }}
        className="space-y-4"
      >
        {GROUPS.map((g) => {
          const fields = FIELDS.filter((f) => f.group === g.id).map(renderField);
          if (g.id !== "battery") {
            return (
              <fieldset key={g.id}>
                <legend className="mb-2 text-[12.5px] font-semibold text-ink">{g.title}</legend>
                <div className="grid gap-3 sm:grid-cols-2">{fields}</div>
              </fieldset>
            );
          }
          return (
            <Collapsible key={g.id} open={batteryOpen} onOpenChange={setBatteryOpen}>
              <CollapsibleTrigger className="group flex w-full items-center gap-1 text-left text-[12.5px] font-semibold text-ink">
                <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" /> {g.title}
                <span className="ml-1 font-normal text-ink-faint">{g.note}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">{fields}</div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}

        <fieldset className="space-y-2">
          <legend className="text-[12.5px] font-semibold text-ink">LED 查找权限</legend>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2.5">
            <label htmlFor="setting-led_enabled" className="min-w-0 text-[12.5px]">
              <span className="font-medium">
                允许 LED 查找
                {ledDirty && (
                  <span className="ml-1.5 text-[11px] font-normal text-persimmon-ink">
                    草稿已修改 · 设备已保存为{current.led_enabled ? "允许" : "不允许"}
                  </span>
                )}
              </span>
              <span className="block text-ink-faint">
                草稿：{draft.led_enabled ? "允许" : "不允许"} · 设备已保存：{current.led_enabled ? "允许" : "不允许"}
              </span>
            </label>
            <button
              id="setting-led_enabled"
              type="button"
              role="switch"
              aria-checked={draft.led_enabled}
              aria-describedby="setting-led_enabled-help"
              disabled={!ledToggleEnabled}
              onClick={() => setDraft({ ...draft, led_enabled: !draft.led_enabled })}
              className={cn(
                "relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                draft.led_enabled ? "bg-persimmon" : "bg-muted-foreground/30",
              )}
            >
              <span className={cn("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform", draft.led_enabled && "translate-x-4")} />
            </button>
          </div>
          <p id="setting-led_enabled-help" className="text-[12px] leading-relaxed text-ink-faint">
            {!ledEncrypted
              ? "需要已加密的连接才能修改 LED 查找权限。"
              : hardware === "unknown"
              ? "LED 硬件未知：加密后读到遥测才能判断，在此之前不能修改。"
              : hardware === "absent"
                ? "此设备未配备 LED，不能开启；可用按键辨认这台 Tag。"
                : "开启只是允许查找，不会自动闪灯；保存并收到回执后，才能在“LED 查找”卡片中闪灯。只在草稿中关闭不会影响设备：保存关闭后，固件会立即停止正在进行的闪灯。"}
          </p>
        </fieldset>
        {globalErrors.length > 0 && (
          <InlineNotice tone="error">
            {globalErrors.map((e) => (
              <p key={e}>{e}</p>
            ))}
          </InlineNotice>
        )}
        {shortenWarning && <InlineNotice tone="warn">{shortenWarning}</InlineNotice>}
        {nextWindowChanged && (
          <InlineNotice tone="info">等待连接窗口和可连接广播间隔在下一次打开窗口时生效，不影响当前连接。</InlineNotice>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!canSave}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {saving ? "等待 commit 回执…" : changedCount ? `保存 ${changedCount} 项修改` : "保存参数"}
          </Button>
          {changedCount > 0 && (
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(toDraft(current))}>
              <Undo2 /> 还原为设备当前值
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => setDraft(toDraft(DEFAULT_SETTINGS))}
            title="只填充草稿，不会写入设备"
          >
            <RotateCcw /> 草稿填入出厂默认值
          </Button>
        </div>
      </form>
      {session.settingsOutcome && (
        <div className="mt-3">
          <OutcomeNotice outcome={session.settingsOutcome} what="参数" />
          {session.settingsOutcome.kind === "committed" && !session.linkUp && (
            <p className="mt-1.5 text-[12px] text-ink-soft">连接已结束；保存已由设备回执确认，断开不影响这一结果。</p>
          )}
          {session.settingsOutcome.kind === "committed" && savedLedChange !== null && (
            <p className="mt-1.5 text-[12px] text-ink-soft">
              {savedLedChange
                ? "设备已保存“允许 LED 查找”：之后在已连接并加密时，可在“LED 查找”卡片中闪灯。开启本身不会让灯亮。"
                : "设备已保存“不允许 LED 查找”。按固件规则，保存关闭时会立即停止正在进行的闪灯。"}
            </p>
          )}
          {session.settingsOutcome.kind === "rejected" && session.settingsOutcome.status.errorCode === 2 && (
            <p className="mt-1.5 text-[12px] text-ink-soft">原因码 2：设备没有 LED 硬件，不能开启 LED 查找。</p>
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------------- LED identification ---------------- */

const LED_HARDWARE_TEXT: Record<LedHardware, string> = {
  unknown: "未知",
  present: "已配备 LED",
  absent: "未配备 LED",
};
/** Firmware's automatic maximum for one find request. */
const LED_FIND_SECONDS = 10;

/** Local wall-clock time with seconds, so a 10-second window's start and end differ visibly. */
function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * Standalone LED card, outside the protected tabs, so hardware capability and
 * prerequisites stay visible before pairing or a settings read. Telemetry
 * never reports whether the light is on, so this only shows what the firmware
 * acknowledged.
 */
export function LedSection({ session, now, stale }: { session: NearbySession; now: number; stale: boolean }) {
  const { snapshot, linkUp } = session;
  const hardware = ledHardware(snapshot);
  const encrypted = linkUp && snapshot.encryption === "encrypted";
  const saved = snapshot.settings ? snapshot.settings.led_enabled : null;
  const finding = session.task === "led_find";
  const stopping = session.task === "led_stop";

  // First unmet prerequisite for "find"; the unsaved settings draft never counts.
  const findBlocker = !linkUp
    ? "需要先连接 Tag。"
    : !encrypted
      ? "需要先启用加密管理。"
      : hardware === "unknown"
        ? "尚未读到遥测，LED 硬件未知。请在“状态”页刷新遥测。"
        : hardware === "absent"
          ? "此设备未配备 LED。"
          : saved === null
            ? "尚未读取设备已保存的设置。"
            : !saved
              ? "设备已保存的设置未允许 LED 查找：在“参数”页开启并保存，收到回执后可用。"
              : null;
  // Stop stays available on any capable encrypted link, even if the browser doesn't know a find is running.
  const stopBlocker = !linkUp ? "需要先连接 Tag。" : !encrypted ? "需要先启用加密管理。" : hardware !== "present" ? "需要已配备 LED 的设备。" : null;

  return (
    <Card title="LED 查找" aside={stale ? <Chip tone="warn">断开前数据</Chip> : undefined}>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-[13px]">
        <Fact
          label="LED 硬件（只读）"
          value={LED_HARDWARE_TEXT[hardware]}
          tone={hardware === "present" ? "ok" : hardware === "unknown" ? "muted" : undefined}
          sub={
            hardware === "unknown"
              ? encrypted
                ? "遥测未读取，暂不能判断"
                : "加密后从遥测读取"
              : "来自设备遥测，由硬件决定"
          }
        />
        <Fact
          label="设备已保存的权限"
          value={saved === null ? "未知" : saved ? "允许查找" : "不允许"}
          tone={saved === null ? "muted" : undefined}
          sub={saved === null ? "加密后读取运行参数" : "“参数”页草稿保存前不算"}
        />
      </dl>

      {hardware === "absent" ? (
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-soft">
          这台 Tag 没有 LED。请使用上方的按键辨认：短按 Tag，确认高亮的就是它。
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={!!findBlocker || session.busy} onClick={() => void session.identifyLed(true)}>
              {finding ? <Loader2 className="animate-spin" /> : <Lightbulb />}
              {finding ? "正在发送闪灯指令…" : `闪灯查找 ${LED_FIND_SECONDS} 秒`}
            </Button>
            <Button size="sm" variant="ghost" disabled={!!stopBlocker || session.busy} onClick={() => void session.identifyLed(false)}>
              {stopping ? <Loader2 className="animate-spin" /> : <Square />}
              {stopping ? "正在发送停止指令…" : "停止闪灯"}
            </Button>
          </div>
          {findBlocker && <p className="mt-1.5 text-[12px] text-ink-faint">闪灯查找：{findBlocker}</p>}
          {!findBlocker && stopBlocker && <p className="mt-1.5 text-[12px] text-ink-faint">停止：{stopBlocker}</p>}
        </>
      )}

      {session.ledOutcome && (
        <div className="mt-3">
          <LedOutcomeNotice outcome={session.ledOutcome} linkUp={linkUp} savedOff={saved === false} now={now} />
        </div>
      )}

      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">
        每次最多闪 {LED_FIND_SECONDS} 秒后由固件自动停止；点击停止、保存关闭 LED 权限、断开连接或开始固件升级也会立即停止。闪灯不会延长连接。设备不回报灯当前是否在亮，这里只显示设备对指令的确认。
      </p>
    </Card>
  );
}

function LedOutcomeNotice({ outcome, linkUp, savedOff, now }: { outcome: LedOutcome; linkUp: boolean; savedOff: boolean; now: number }) {
  const what = outcome.action === "find" ? "闪灯指令" : "停止指令";
  if (outcome.kind === "confirmed") {
    if (outcome.action === "stop") {
      return <InlineNotice tone="ok">设备已确认停止指令（{clockTime(outcome.at)}）。</InlineNotice>;
    }
    const end = Date.parse(outcome.at) + LED_FIND_SECONDS * 1000;
    // Find required a saved "allow"; a saved "not allowed" now means it was turned off afterwards.
    const after = !linkUp
      ? "连接已断开；按固件规则，断开时会停止闪灯。"
      : savedOff
        ? "之后已保存“不允许 LED 查找”；按固件规则，保存关闭时会停止闪灯。"
        : now >= end
        ? `已超过 ${LED_FIND_SECONDS} 秒，按固件规则已自动停止。`
        : `按固件规则最晚约 ${clockTime(new Date(end).toISOString())} 自动停止（估算）。`;
    return (
      <InlineNotice tone="ok">
        设备已确认开始闪灯指令（{clockTime(outcome.at)}）。{after}
      </InlineNotice>
    );
  }
  if (outcome.kind === "rejected") {
    return (
      <InlineNotice tone="error">
        设备拒绝了{what}：{LED_REJECT_TEXT[outcome.cause] ?? `原因码 ${outcome.cause}。`}
      </InlineNotice>
    );
  }
  if (outcome.kind === "not_sent") {
    return <InlineNotice tone="error">{what}未发送：{outcome.message}</InlineNotice>;
  }
  return (
    <InlineNotice tone="warn">
      {what}结果未知：{outcome.message} 没有收到本次指令的设备确认，不能确定是否执行。
      {outcome.action === "find" && "如果连接已断开，固件会在断开时停止闪灯；否则最多 10 秒后自动停止。"}
    </InlineNotice>
  );
}

/* ---------------- Maintenance ---------------- */

export function MaintenanceSection({ session }: { session: NearbySession }) {
  const [confirm, setConfirm] = useState<"reboot" | "factory_reset" | null>(null);
  const [ack, setAck] = useState(false);
  const sending = session.task === "reboot" || session.task === "factory_reset";
  const name = session.snapshot.deviceName ?? session.snapshot.device?.name ?? "此 Tag";
  const holdSeconds = session.snapshot.settings?.reset_hold_seconds;

  const send = async () => {
    if (!confirm) return;
    // Not-sent failures surface as the panel notice, uncertain ones as CommandSentNotice; the dialog never pretends success.
    if (confirm === "reboot") await session.reboot();
    else await session.factoryReset();
    setConfirm(null);
  };

  return (
    <Card title="重启与恢复出厂">
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-soft">
            <p className="font-medium text-ink">重启</p>
            <p>
              保留名称、参数和密钥，与 P0.21（nRESET）硬件复位一样不清除任何配置。已配置设备重启后恢复 Find My 广播；未配置设备启动时先开一次可连接窗口，结束后等待按键。
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={session.busy || !session.linkUp} onClick={() => setConfirm("reboot")}>
            <Power /> 重启…
          </Button>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2 border-t border-line pt-3">
          <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-soft">
            <p className="font-medium text-danger">恢复出厂</p>
            <p>
              清空名称、参数和密钥，生成新的随机名 ATAG-XXXXXXXX。效果等同长按按键 {holdSeconds ?? 5} 秒；P0.21 硬件复位不会恢复出厂。原密钥将不再用于这个 Tag。
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="border-danger/40 text-danger hover:bg-danger-wash hover:text-danger"
            disabled={session.busy || !session.linkUp}
            onClick={() => {
              setAck(false);
              setConfirm("factory_reset");
            }}
          >
            <RotateCcw /> 恢复出厂…
          </Button>
        </div>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !sending && !open && setConfirm(null)}>
        <AlertDialogContent className="rounded-2xl bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "reboot" ? `重启“${name}”？` : `将“${name}”恢复出厂？`}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-ink-soft">
                {confirm === "reboot" ? (
                  <ul className="list-disc space-y-1 pl-5">
                    <li>连接会断开；名称、参数和密钥都保留。</li>
                    <li>网页只能确认指令已发出，无法确认重启完成。要核验，请在重启后重新连接（已配置设备需先短按 Tag），启用加密后查看运行时间。</li>
                  </ul>
                ) : (
                  <>
                    <ul className="list-disc space-y-1 pl-5">
                      <li>清空名称、全部运行参数和 Find My 密钥，生成新的随机名称。</li>
                      <li>设备变为未配置状态，不再发送原密钥的 Find My 广播；需要重新配置密钥。</li>
                      <li>此浏览器中的档案和私钥不会被删除，但不再对应这个 Tag 的广播。</li>
                      <li>网页只能确认指令已发出；Flash 是否已清空，需要重新连接后核验。</li>
                    </ul>
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line px-3 py-2 text-ink">
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--danger)]" />
                      我了解恢复出厂会清空名称、参数和密钥，且无法撤销。
                    </label>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>取消</AlertDialogCancel>
            <Button
              variant={confirm === "reboot" ? "default" : "destructive"}
              disabled={sending || (confirm === "factory_reset" && !ack)}
              onClick={() => void send()}
            >
              {sending && <Loader2 className="animate-spin" />}
              {confirm === "reboot" ? "发送重启指令" : "发送恢复出厂指令"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/** Shown after a reboot / factory-reset command until the user reconnects and verifies. */
export function CommandSentNotice({ sent, snapshot, now }: { sent: CommandSent; snapshot: BleSessionSnapshot; now: number }) {
  const label = sent.kind === "reboot" ? "重启" : "恢复出厂";
  // The serial is only known after encryption (browsers block 2a25); never treat an unknown one as a match or mismatch.
  const currentSerial = snapshot.identity?.serial ?? null;
  const sameTag = !!sent.serial && currentSerial === sent.serial;
  const linkUp = snapshot.state === "connected" || snapshot.state === "pairing" || snapshot.state === "writing";
  const newLink = linkUp && !!snapshot.connectedAt && Date.parse(snapshot.connectedAt) > Date.parse(sent.at);
  const reconnected = sameTag && newLink;
  const t = reconnected && snapshot.telemetryReceivedAt && Date.parse(snapshot.telemetryReceivedAt) > Date.parse(sent.at) ? snapshot.telemetry : null;

  if (reconnected && t) {
    const since = (now - Date.parse(sent.at)) / 1000;
    const rebooted = t.uptimeSeconds <= since + 5;
    if (sent.kind === "reboot") {
      return (
        <InlineNotice tone={rebooted ? "ok" : "warn"}>
          {rebooted
            ? `已核验：同一序列号的 Tag 运行时间 ${formatDuration(t.uptimeSeconds)}，晚于重启指令，确认已重启。`
            : `运行时间 ${formatDuration(t.uptimeSeconds)} 早于重启指令，设备可能没有重启。`}
        </InlineNotice>
      );
    }
    const cleared = t.keyMode === "unset";
    const renamed = snapshot.deviceName !== null && snapshot.deviceName !== sent.previousName;
    return (
      <InlineNotice tone={cleared && renamed ? "ok" : "warn"}>
        {cleared && renamed
          ? `已核验：密钥为未配置，名称已变为“${snapshot.deviceName}”，恢复出厂完成。`
          : `核验未通过：密钥${cleared ? "已清空" : "仍存在"}，名称${renamed ? "已变化" : snapshot.deviceName === null ? "未读取" : "未变化"}。`}
      </InlineNotice>
    );
  }
  return (
    <InlineNotice tone="info">
      {sent.delivery === "unknown"
        ? `${label}指令于 ${absoluteTime(sent.at)} 发起，指令发送或执行结果未知，请重新连接核验。连接在确认前中断，设备可能已执行，也可能没收到；请先核验，不要直接重发。`
        : `${label}指令已于 ${absoluteTime(sent.at)} 发送，等待设备断开。这只表示指令已发出，不代表${sent.kind === "factory_reset" ? " Flash 已清空" : "重启已完成"}。`}
      {sent.kind === "reboot"
        ? " 已配置设备重启后恢复 Find My 广播，需短按 Tag 打开窗口；未配置设备启动时会先自动开一次可连接窗口，窗口结束后才等待按键。重新连接并启用加密后可核验运行时间。"
        : " 恢复出厂后设备变为未配置并换了新的随机名，启动时会先自动开一次可连接窗口（默认 60 秒），错过后短按即可重开。在浏览器中选择新名称、启用加密后可核验名称与密钥状态。"}
      {newLink && !currentSerial && " 已重新连接；序列号待加密后读取，启用加密并读取遥测后才能确认是同一台并核验。"}
      {sameTag && newLink && !t && " 已重新连接同一序列号，读取遥测后即可核验。"}
      {newLink && !!currentSerial && !!sent.serial && !sameTag && " 当前连接的序列号与发送指令的 Tag 不同，无法核验。"}
    </InlineNotice>
  );
}
