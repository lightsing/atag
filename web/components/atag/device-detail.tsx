"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Bluetooth,
  Check,
  ChevronLeft,
  Copy,
  History,
  Loader2,
  Pencil,
  PlugZap,
  RefreshCw,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import type { LocationReport, TagDevice } from "@/lib/contracts";
import type { QuerySettingsView } from "@/lib/workspace/report-query";
import {
  absoluteTime,
  formatAccuracy,
  formatCoordinates,
  formatRotation,
  formatVoltage,
  isStale,
  relativeTime,
  shortTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Chip, DeviceGlyph } from "./primitives";
import { QuerySettingsSection } from "./query-settings";
import type { QuerySettings, RefreshTask } from "./use-atag-session";
import type { HistoryRange, ReportsState } from "./use-reports";

interface DeviceDetailProps {
  device: TagDevice;
  /** What fetching fresh reports still needs. */
  fetchReadiness: FetchReadiness;
  reports: ReportsState;
  range: HistoryRange;
  focusedReportId: string | null;
  refreshTask: RefreshTask | undefined;
  backLabel: "close" | "back";
  onRangeChange(range: HistoryRange): void;
  onFocusReport(id: string | null): void;
  onRefresh(): void;
  onRetryReports(): void;
  onEdit(): void;
  onDelete(): void;
  onClose(): void;
  onCopy(text: string): Promise<boolean>;
  onOpenNearby(): void;
  /** Open nearby provisioning with this saved profile preselected. */
  onConfigure(): void;
  onOpenBridgeSettings(): void;
  queryRevision: number;
  onLoadQuerySettings(id: string): Promise<QuerySettingsView>;
  onSaveQuerySettings(id: string, patch: Partial<QuerySettings>): Promise<void>;
}

export interface FetchReadiness {
  bridgeConnected: boolean;
  /** Apple account signed in from this browser (query session only). */
  account: "missing" | "ready" | "expired";
}

/** Report battery voltage is decoded and saved in this browser. */
function reportVoltage(report: LocationReport): { value: string; sub: string } {
  return { value: formatVoltage(report.batteryMillivolts), sub: "电池电压（2.4–4.2 V，约 28.6 mV/档）" };
}

export function DeviceDetail(props: DeviceDetailProps) {
  const { device, reports, range, refreshTask } = props;
  const report = device.latestReport;
  const focused = reports.reports.find((r) => r.id === props.focusedReportId) ?? null;
  const shown = focused ?? report;
  const stale = isStale(report);
  const readiness = props.fetchReadiness;

  return (
    <article aria-label={`${device.name} 详情`} className="flex flex-col">
      <header className="flex items-start gap-3 px-4 pb-3 pt-4">
        <button
          type="button"
          onClick={props.onClose}
          aria-label={props.backLabel === "back" ? "返回设备列表" : "关闭详情"}
          className="-ml-1.5 grid size-9 shrink-0 place-items-center rounded-xl text-ink-soft hover:bg-muted hover:text-ink"
        >
          {props.backLabel === "back" ? <ChevronLeft className="size-5" /> : <X className="size-[18px]" />}
        </button>
        <DeviceGlyph icon={device.icon} color={device.color} size="lg" muted={!report} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold leading-tight tracking-tight text-ink">{device.name}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {report ? (
              <Chip tone={stale ? "warn" : "ok"} dot>
                {relativeTime(report.observedAt)}收到位置报告
              </Chip>
            ) : (
              <Chip>暂无位置报告</Chip>
            )}
            {device.provisioningState === "draft" && <Chip tone="warn">草稿 · Tag 未配置</Chip>}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={props.onEdit} aria-label="编辑名称和图标" title="编辑名称和图标">
          <Pencil />
        </Button>
      </header>

      {device.provisioningState === "draft" && (
        <div className="mx-4 mb-3 rounded-xl bg-warn-wash px-3 py-2.5 text-[13px] text-warn">
          <p>
            私钥已保存在此浏览器，但还没有确认写入任何 Tag，因此不会有报告。Tag 在手边时短按开窗，再写入这份档案的同一套密钥。
          </p>
          <Button size="sm" variant="outline" className="mt-2 bg-card" onClick={props.onConfigure}>
            <Bluetooth /> 写入 Tag
          </Button>
        </div>
      )}

      {readiness.account !== "ready" && (
        <div className="mx-4 mb-3 flex gap-2.5 rounded-xl bg-warn-wash px-3 py-2.5 text-[13px] text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            {readiness.account === "expired" ? "此浏览器的 Apple 登录已失效。" : "此浏览器还没有登录 Apple 账号。"}
            下载新报告前请在设置中{readiness.account === "expired" ? "重新" : ""}登录 Apple 账号。已保存的历史仍可离线查看。
          </p>
        </div>
      )}

      {/* Latest / focused location */}
      <section aria-label="位置报告" className="mx-4 rounded-2xl border border-line bg-card">
        {shown ? (
          <>
            <div className="flex items-start justify-between gap-3 px-3.5 pt-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink-faint">{focused ? "所选历史报告" : "最新位置"}</p>
                <p className="mt-1 font-mono text-[15px] font-medium tabular-nums text-ink">
                  {formatCoordinates(shown.latitude, shown.longitude)}
                </p>
              </div>
              <CopyButton text={formatCoordinates(shown.latitude, shown.longitude)} onCopy={props.onCopy} />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 px-3.5 pb-3 pt-3 text-[13px]">
              <Fact label="报告时间" value={absoluteTime(shown.observedAt)} sub={relativeTime(shown.observedAt)} />
              <Fact label="精度" value={formatAccuracy(shown.horizontalAccuracyMeters)} />
              <Fact
                label="电压（报告时）"
                value={reportVoltage(shown).value}
                sub={reportVoltage(shown).sub}
              />
              <Fact label="来源" value="Find My 报告" />
            </dl>
            {focused && (
              <div className="border-t border-line px-3.5 py-2">
                <button type="button" onClick={() => props.onFocusReport(null)} className="text-[13px] font-medium text-persimmon-ink hover:underline">
                  回到最新位置
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="px-3.5 py-4">
            <p className="text-sm font-medium text-ink">暂无位置报告</p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
              tag 需要被附近的 Apple 设备发现后才会产生报告。刚配置的 tag 通常需要一段时间。
            </p>
          </div>
        )}
        {stale && !focused && (
          <p className="flex items-center gap-1.5 border-t border-line px-3.5 py-2 text-[12.5px] text-warn">
            <AlertTriangle className="size-3.5" /> 最新报告已超过 24 小时，位置可能已变化。
          </p>
        )}
      </section>

      <RefreshBar
        task={refreshTask}
        readiness={readiness}
        onRefresh={props.onRefresh}
        onOpenBridgeSettings={props.onOpenBridgeSettings}
      />

      {/* History */}
      <section aria-label="历史报告" className="mt-4 px-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <History className="size-4 text-ink-faint" /> 历史报告
          </h3>
          <div role="radiogroup" aria-label="时间范围" className="inline-flex rounded-lg bg-muted p-0.5">
            {(["24h", "7d"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={range === value}
                onClick={() => props.onRangeChange(value)}
                className={cn(
                  "h-7 rounded-md px-3 text-[13px] font-medium transition-colors",
                  range === value ? "bg-card text-ink shadow-sm" : "text-ink-soft hover:text-ink",
                )}
              >
                {value === "24h" ? "24 小时" : "7 天"}
              </button>
            ))}
          </div>
        </div>
        <HistoryList {...props} />
        <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
          历史是已保存的离散报告，不代表完整连续轨迹。点击条目可在地图上查看。
        </p>
      </section>

      {/* Device facts */}
      <section aria-label="设备信息" className="mt-5 px-4">
        <h3 className="text-sm font-semibold text-ink">设备信息</h3>
        <dl className="mt-2 divide-y divide-line rounded-2xl border border-line bg-card text-[13px]">
          <Row label="广播模式" value={formatRotation(device.advertisingMode, null)} />
          {device.rotationIntervalMinutes !== null && (
            <Row label="建档轮换周期" value={`${device.rotationIntervalMinutes} 分钟`} />
          )}
          {device.provisioningState && (
            <Row
              label="配置状态"
              value={
                device.provisioningState === "draft"
                  ? "草稿：密钥已保存，Tag 未确认写入"
                  : "已配置：Tag 回执确认写入"
              }
            />
          )}
          <Row label="固件版本" value={device.firmwareVersion ?? "未知"} />
          <Row label="芯片序列号" value={device.chipSerial ?? "未记录"} mono={!!device.chipSerial} />
          <Row label="档案创建" value={absoluteTime(device.createdAt)} />
          <Row
            label="可用功能"
            value={
              [
                device.capabilities.provisioning && "密钥配置",
                device.capabilities.management && "附近管理",
                device.capabilities.telemetry && "遥测",
                device.capabilities.ring && "响铃",
                device.capabilities.ota && "OTA",
              ]
                .filter(Boolean)
                .join("、") || "无"
            }
          />
        </dl>
        <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
          这里的名称是档案昵称，与写入 Tag 的蓝牙名称分开。芯片序列号只在本浏览器生成的密钥被 Tag 确认写入后绑定。固件没有响铃、OTA 或精确寻找接口；报告电压来自 Find My 状态字节，按每条报告保存的编码显示，未换算为电池百分比。
        </p>
      </section>

      {device.advertisingMode === "rotating" && (
        <QuerySettingsSection key={device.id} deviceId={device.id} revision={props.queryRevision} onLoad={props.onLoadQuerySettings} onSave={props.onSaveQuerySettings} />
      )}

      <section aria-label="附近蓝牙" className="mt-5 px-4">
        <div className="rounded-2xl border border-line bg-card px-3.5 py-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">附近蓝牙</h3>
            <Button size="sm" variant="outline" onClick={props.onOpenNearby}>
              <Bluetooth /> 附近管理
            </Button>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft">
            地图上的报告来自 Find My 网络，不代表 Tag 此刻在附近或可以连接。Tag 在手边时，短按按键后可连接查看电压、改名和调整参数；连接到的设备只按芯片序列号与档案对应，序列号在启用加密后读取。
          </p>
        </div>
      </section>

      <section className="mt-5 px-4 pb-6">
        <Button variant="ghost" className="w-full justify-start text-danger hover:bg-danger-wash hover:text-danger" onClick={props.onDelete}>
          <Trash2 /> 删除设备档案…
        </Button>
      </section>
    </article>
  );
}

function RefreshBar({
  task,
  readiness,
  onRefresh,
  onOpenBridgeSettings,
}: {
  task: RefreshTask | undefined;
  readiness: FetchReadiness;
  onRefresh(): void;
  onOpenBridgeSettings(): void;
}) {
  const running = task?.status === "running";
  if (!running && (!readiness.bridgeConnected || readiness.account !== "ready")) {
    return (
      <div className="mx-4 mt-3 flex items-center gap-3">
        <Button variant="outline" onClick={onOpenBridgeSettings} className="shrink-0">
          <PlugZap /> 刷新设置
        </Button>
        <p className="min-w-0 text-[12.5px] leading-snug text-ink-soft">
          {!readiness.bridgeConnected && readiness.account !== "ready"
            ? "下载新报告需要连接本地桥接并登录 Apple 账号。"
            : !readiness.bridgeConnected
              ? "连接本地桥接后可下载新报告。"
              : readiness.account === "expired"
                ? "Apple 登录已失效，重新登录后可下载新报告。"
                : "登录 Apple 账号后可下载新报告。"}
          {task?.status === "failed" && <span className="block text-danger">{task.error.message}</span>}
        </p>
      </div>
    );
  }
  let message: React.ReactNode = "经本地桥接下载最新 Find My 报告，并在浏览器内解密。";
  let tone = "text-ink-soft";
  if (task?.status === "running") {
    message = task.phase === "running" ? "正在下载并解密报告…" : "任务已排队…";
  } else if (task?.status === "done") {
    message =
      task.newReportCount > 0
        ? `收到 ${task.newReportCount} 条新报告`
        : "暂无新报告。tag 需要被附近的 Apple 设备发现后才会产生报告。";
    tone = task.newReportCount > 0 ? "text-ok" : "text-ink-soft";
  } else if (task?.status === "failed") {
    message = task.error.message;
    tone = "text-danger";
  }
  return (
    <div className="mx-4 mt-3 flex items-center gap-3">
      <Button onClick={onRefresh} disabled={running} className="shrink-0 bg-persimmon text-white hover:bg-persimmon-ink">
        {running ? <Loader2 className="animate-spin" /> : task?.status === "failed" ? <RotateCw /> : <RefreshCw />}
        {running ? "刷新中" : task?.status === "failed" ? "重试刷新" : "刷新报告"}
      </Button>
      <p role="status" aria-live="polite" className={cn("min-w-0 text-[12.5px] leading-snug", tone)}>
        {message}
      </p>
    </div>
  );
}

function HistoryList(props: DeviceDetailProps) {
  const { reports, focusedReportId, device } = props;
  if (reports.status === "loading" && reports.reports.length === 0) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-2xl border border-line bg-card px-3.5 py-3 text-[13px] text-ink-soft">
        <Loader2 className="size-3.5 animate-spin" /> 正在载入历史…
      </div>
    );
  }
  if (reports.status === "error") {
    return (
      <div className="mt-2 rounded-2xl border border-line bg-card px-3.5 py-3 text-[13px]">
        <p className="text-danger">{reports.error?.message ?? "历史载入失败。"}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={props.onRetryReports}>
          <RotateCw /> 重试
        </Button>
      </div>
    );
  }
  if (reports.reports.length === 0) {
    return (
      <div className="mt-2 rounded-2xl border border-dashed border-line px-3.5 py-3 text-[13px] text-ink-soft">
        {props.range === "24h" ? "最近 24 小时没有报告。" : "最近 7 天没有报告。"}
        {props.range === "24h" && device.latestReport && (
          <button type="button" onClick={() => props.onRangeChange("7d")} className="ml-1 font-medium text-persimmon-ink hover:underline">
            查看 7 天
          </button>
        )}
      </div>
    );
  }
  const latestId = device.latestReport?.id;
  return (
    <>
      <p className="mt-2 text-[12px] text-ink-faint">
        共 {reports.reports.length} 条{reports.truncated ? "（只载入了前一部分，更早的报告未显示）" : ""}
        {reports.status === "loading" && " · 正在更新…"}
      </p>
      <ol className="mt-1.5 max-h-64 overflow-y-auto rounded-2xl border border-line bg-card scrollbar-thin" aria-label="报告列表">
        {reports.reports.map((r: LocationReport) => {
          const active = r.id === focusedReportId || (!focusedReportId && r.id === latestId);
          return (
            <li key={r.id} className="border-b border-line last:border-b-0">
              <button
                type="button"
                onClick={() => props.onFocusReport(r.id === latestId ? null : r.id)}
                aria-pressed={active}
                className={cn(
                  "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] transition-colors",
                  active ? "bg-persimmon-wash/60" : "hover:bg-muted/60",
                )}
              >
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: active ? device.color : "var(--ink-faint)" }}
                />
                <span className="w-24 shrink-0 tabular-nums text-ink">{shortTime(r.observedAt)}</span>
                <span className="flex-1 tabular-nums text-ink-soft">{formatAccuracy(r.horizontalAccuracyMeters)}</span>
                <span className="tabular-nums text-ink-soft">{reportVoltage(r).value}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

function CopyButton({ text, onCopy }: { text: string; onCopy(text: string): Promise<boolean> }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const handle = async () => {
    const ok = await onCopy(text);
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1800);
  };
  return (
    <Button variant="outline" size="sm" onClick={handle} aria-live="polite" className="shrink-0">
      {state === "copied" ? <Check className="text-ok" /> : <Copy />}
      {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制坐标"}
    </Button>
  );
}

function Fact({ label, value, sub, muted }: { label: string; value: string; sub?: string; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-ink-faint">{label}</dt>
      <dd className={cn("mt-0.5 truncate tabular-nums", muted ? "text-ink-faint" : "text-ink")}>{value}</dd>
      {sub && <dd className="text-[12px] text-ink-soft">{sub}</dd>}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 px-3.5 py-2.5">
      <dt className="w-20 shrink-0 text-ink-faint">{label}</dt>
      <dd className={cn("min-w-0 flex-1 break-words text-ink", mono && "font-mono text-[12.5px]")}>{value}</dd>
    </div>
  );
}
