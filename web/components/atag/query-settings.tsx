"use client";

import { useEffect, useState } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import { absoluteTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ROTATION_COUNT_MAX, ROTATION_START_MAX, type QuerySettingsView } from "@/lib/workspace/report-query";
import type { QuerySettings } from "@/lib/workspace/types";
import { Button } from "@/components/ui/button";
import { errorText } from "./workspace-data";

function parseBounded(text: string, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
}

/** Mount with `key={deviceId}` so form state never carries over between devices. */
export function QuerySettingsSection({
  deviceId,
  revision,
  onLoad,
  onSave,
}: {
  deviceId: string;
  revision: number;
  onLoad(id: string): Promise<QuerySettingsView>;
  onSave(id: string, patch: Partial<QuerySettings>): Promise<void>;
}) {
  const [saved, setSaved] = useState<QuerySettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modeDraft, setModeDraft] = useState<QuerySettings["rotationMode"]>();
  const [startDraft, setStartDraft] = useState<string>();
  const [countDraft, setCountDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    onLoad(deviceId).then(
      (settings) => {
        if (cancelled) return;
        setSaved(settings);
        setLoadError(null);
      },
      (err) => !cancelled && setLoadError(errorText(err, "无法读取查询设置。")),
    );
    return () => {
      cancelled = true;
    };
  }, [deviceId, onLoad, revision]);

  const savedMode = saved?.rotationMode ?? "auto";
  const mode = modeDraft ?? savedMode;
  const start = startDraft ?? String(saved?.rotationStart ?? "");
  const count = countDraft ?? String(saved?.rotationCount ?? "");
  const startValue = parseBounded(start, ROTATION_START_MAX);
  const countValue = parseBounded(count, ROTATION_COUNT_MAX);
  const invalid = mode === "manual" && (startValue === null || countValue === null);
  const dirty = !!saved && (mode !== savedMode ||
    (mode === "manual" && (startValue !== saved.rotationStart || countValue !== saved.rotationCount)));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!saved || invalid || !dirty) return;
    const patch: Partial<QuerySettings> = { rotationMode: mode };
    if (mode === "manual" && startValue !== null && countValue !== null) {
      patch.rotationStart = startValue;
      patch.rotationCount = countValue;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onSave(deviceId, patch);
      setSaved((latest) => latest && { ...latest, ...patch });
      setModeDraft(undefined);
      setStartDraft(undefined);
      setCountDraft(undefined);
      setMessage({ tone: "ok", text: "已保存到此浏览器，下次刷新报告时生效。" });
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "保存失败。") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`query-${deviceId}`} className="mt-5 px-4">
      <h3 id={`query-${deviceId}`} className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <SlidersHorizontal className="size-4 text-ink-faint" /> 报告查询设置
      </h3>
      <form onSubmit={save} className="mt-2 space-y-3 rounded-2xl border border-line bg-card px-3.5 py-3 text-[13px]">
        {loadError ? (
          <p role="alert" className="text-danger">{loadError}</p>
        ) : !saved ? (
          <p className="flex items-center gap-2 text-ink-soft">
            <Loader2 className="size-3.5 animate-spin" /> 正在读取…
          </p>
        ) : (
          <>
            <label className="grid gap-1">
              <span className="font-medium">密钥查询范围</span>
              <select
                value={mode}
                onChange={(e) => {
                  setModeDraft(e.target.value === "manual" ? "manual" : "auto");
                  setMessage(null);
                }}
                disabled={busy}
                className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm"
              >
                <option value="auto">自动推算</option>
                <option value="manual">手动指定</option>
              </select>
            </label>
            {saved.intervalMinutes !== null && (
              <p className="text-[12px] text-ink-soft">
                轮换周期：{saved.intervalSource === "report" && "约 "}{saved.intervalMinutes} 分钟（
                {saved.intervalSource === "tag" ? "Tag 最近确认" : saved.intervalSource === "report" ? "报告估算" : "建档设置"}）
              </p>
            )}
            {mode === "auto" ? (
              <AutomaticRange settings={saved} />
            ) : (
              <div className="grid gap-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    <span className="font-medium">起始轮换序号</span>
                    <input
                      inputMode="numeric"
                      value={start}
                      onChange={(e) => { setStartDraft(e.target.value); setMessage(null); }}
                      disabled={busy}
                      aria-invalid={startValue === null}
                      className={cn(
                        "h-9 rounded-lg border bg-background px-2.5 text-sm tabular-nums",
                        startValue === null ? "border-danger" : "border-input",
                      )}
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="font-medium">查询密钥数</span>
                    <input
                      inputMode="numeric"
                      value={count}
                      onChange={(e) => { setCountDraft(e.target.value); setMessage(null); }}
                      disabled={busy}
                      aria-invalid={countValue === null}
                      className={cn(
                        "h-9 rounded-lg border bg-background px-2.5 text-sm tabular-nums",
                        countValue === null ? "border-danger" : "border-input",
                      )}
                    />
                  </label>
                </div>
                <p className={cn("text-[12px] leading-relaxed", invalid ? "text-danger" : "text-ink-faint")}>
                  起始序号 1–{ROTATION_START_MAX.toLocaleString("en-US")}，密钥数 1–{ROTATION_COUNT_MAX}。可参考「附近管理」中的当前轮换计数。
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" variant="outline" disabled={!dirty || invalid || busy}>
                {busy && <Loader2 className="animate-spin" />} 保存设置
              </Button>
              {message && (
                <p role={message.tone === "error" ? "alert" : "status"} className={cn("text-[12.5px]", message.tone === "error" ? "text-danger" : "text-ok")}>
                  {message.text}
                </p>
              )}
            </div>
          </>
        )}
      </form>
    </section>
  );
}

function AutomaticRange({ settings }: { settings: QuerySettingsView }) {
  const { estimate } = settings;
  const range = estimate ?? settings;
  return (
    <div className="space-y-1 rounded-lg bg-muted px-2.5 py-2">
      <p className="font-medium tabular-nums text-ink">
        {estimate ? "预计查询" : "暂用范围"} {range.rotationStart}–{range.rotationStart + range.rotationCount - 1} 轮（{range.rotationCount} 把密钥）
      </p>
      {estimate ? (
        <p className="text-[12px] leading-relaxed text-ink-soft">
          预计当前第 {estimate.estimatedRotation} 轮。依据{estimate.anchor.source === "tag" ? " Tag 读数" : "已解密报告"}：
          {absoluteTime(estimate.anchor.observedAt)} 第 {estimate.anchor.rotation} 轮。刷新时会重新计算。
          {estimate.limited && " 查询范围已达上限，可手动调整。"}
        </p>
      ) : (
        <p className="text-[12px] leading-relaxed text-ink-soft">
          收到带轮次的报告或在「附近管理」读取已绑定的 Tag 后，会自动推算范围。
        </p>
      )}
    </div>
  );
}
