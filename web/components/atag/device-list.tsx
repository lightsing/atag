"use client";

import { useMemo } from "react";
import { ArrowDownAZ, Clock3, FileUp, Loader2, Plus, RotateCw, Search, X } from "lucide-react";
import type { TagDevice } from "@/lib/contracts";
import { formatAccuracy, formatVoltage, isStale, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DeviceGlyph } from "./primitives";
import type { LoadState, RefreshTask } from "./use-atag-session";
import type { ClientError } from "@/lib/client-support";

export type SortOrder = "recent" | "name";

interface DeviceListProps {
  devices: TagDevice[];
  devicesState: LoadState;
  devicesError: ClientError | null;
  selectedId: string | null;
  query: string;
  sort: SortOrder;
  refreshTasks: Record<string, RefreshTask>;
  onQueryChange(value: string): void;
  onSortChange(value: SortOrder): void;
  onSelect(id: string): void;
  onRetry(): void;
  /** Opens backup restore. */
  onOpenData(): void;
  onAddDevice(): void;
}

export function sortDevices(devices: TagDevice[], sort: SortOrder): TagDevice[] {
  const list = [...devices];
  if (sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return list.sort((a, b) => {
    const at = a.latestReport ? Date.parse(a.latestReport.observedAt) : -Infinity;
    const bt = b.latestReport ? Date.parse(b.latestReport.observedAt) : -Infinity;
    return bt - at;
  });
}

export function DeviceList(props: DeviceListProps) {
  const { devices, query, sort, selectedId, onSelect, refreshTasks } = props;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? devices.filter((d) => d.name.toLowerCase().includes(q)) : devices;
    return sortDevices(filtered, sort);
  }, [devices, query, sort]);

  const body = renderBody();

  function renderBody() {
    if (props.devicesState === "loading" && devices.length === 0) {
      return (
        <div className="space-y-2 px-3 py-2" aria-busy="true" aria-label="正在载入设备">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl p-2.5">
              <span className="size-9 animate-pulse rounded-[10px] bg-muted" />
              <span className="flex-1 space-y-2">
                <span className="block h-3 w-2/5 animate-pulse rounded bg-muted" />
                <span className="block h-2.5 w-3/5 animate-pulse rounded bg-muted" />
              </span>
            </div>
          ))}
        </div>
      );
    }
    if (props.devicesState === "error") {
      return (
        <EmptyBlock
          title="无法读取此浏览器中的设备"
          text={props.devicesError?.message ?? "请重试。"}
          action={
            <Button size="sm" variant="outline" onClick={props.onRetry}>
              <RotateCw /> 重试
            </Button>
          }
        />
      );
    }
    if (devices.length === 0) {
      return (
        <EmptyBlock
          title="此浏览器中还没有设备"
          text="在浏览器内生成密钥并通过蓝牙配置 Tag，或从加密备份恢复。设备只保存在此浏览器，记得备份。"
          action={
            <>
              <Button size="sm" onClick={props.onAddDevice}>
                <Plus /> 添加设备
              </Button>
              <Button size="sm" variant="outline" onClick={props.onOpenData}>
                <FileUp /> 导入
              </Button>
            </>
          }
        />
      );
    }
    if (visible.length === 0) {
      return <EmptyBlock title={`没有匹配“${query.trim()}”的设备`} text="换个关键词试试。" />;
    }
    return (
      <ul className="space-y-0.5 px-2 pb-3" aria-label="设备">
        {visible.map((device) => (
          <li key={device.id}>
            <DeviceRow
              device={device}
              selected={device.id === selectedId}
              refreshing={refreshTasks[device.id]?.status === "running"}
              onSelect={() => onSelect(device.id)}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {devices.length > 0 && (
        <div className="flex items-center gap-2 px-3 pb-2 pt-1">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">搜索设备</span>
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => props.onQueryChange(e.target.value)}
              placeholder="搜索设备名称"
              className="h-10 w-full rounded-xl border border-line bg-card pl-9 pr-9 text-sm outline-none placeholder:text-ink-faint focus-visible:border-persimmon focus-visible:ring-2 focus-visible:ring-persimmon/25 lg:h-9 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                onClick={() => props.onQueryChange("")}
                aria-label="清除搜索"
                className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-ink-faint hover:bg-muted hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            )}
          </label>
          <button
            type="button"
            onClick={() => props.onSortChange(sort === "recent" ? "name" : "recent")}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-line bg-card px-3 text-[13px] font-medium text-ink-soft hover:text-ink lg:h-9"
            aria-label={sort === "recent" ? "当前按最近报告排序，切换为按名称" : "当前按名称排序，切换为按最近报告"}
          >
            {sort === "recent" ? <Clock3 className="size-3.5" /> : <ArrowDownAZ className="size-3.5" />}
            {sort === "recent" ? "最近" : "名称"}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{body}</div>
    </div>
  );
}

function DeviceRow({
  device,
  selected,
  refreshing,
  onSelect,
}: {
  device: TagDevice;
  selected: boolean;
  refreshing: boolean;
  onSelect(): void;
}) {
  const report = device.latestReport;
  const stale = isStale(report);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors",
        selected ? "bg-card shadow-[0_1px_0_var(--line),0_0_0_1px_var(--line)]" : "hover:bg-card/70",
      )}
    >
      <DeviceGlyph icon={device.icon} color={device.color} muted={!report} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold text-ink">{device.name}</span>
          {report ? (
            <span className={cn("shrink-0 text-xs tabular-nums", stale ? "font-medium text-warn" : "text-ink-soft")}>
              {relativeTime(report.observedAt)}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-soft">
          {refreshing ? (
            <span className="inline-flex items-center gap-1 text-persimmon-ink">
              <Loader2 className="size-3 animate-spin" /> 正在刷新报告
            </span>
          ) : report ? (
            <>
              {stale && <span className="font-medium text-warn">报告较旧 ·</span>}
              <span className="tabular-nums">{formatAccuracy(report.horizontalAccuracyMeters)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{formatVoltage(report.batteryMillivolts)}</span>
            </>
          ) : device.provisioningState === "draft" ? (
            <span className="font-medium text-warn">草稿 · Tag 未配置</span>
          ) : (
            <span>暂无位置报告</span>
          )}
        </span>
      </span>
      {selected && <span aria-hidden="true" className="h-8 w-1 shrink-0 rounded-full" style={{ background: device.color }} />}
    </button>
  );
}

function EmptyBlock({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="mx-3 my-2 rounded-2xl border border-dashed border-line px-4 py-6 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-[30ch] text-[13px] leading-relaxed text-ink-soft">{text}</p>
      {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
