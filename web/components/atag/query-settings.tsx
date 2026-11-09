"use client";

import { useEffect, useState } from "react";
import { Loader2, SlidersHorizontal } from "lucide-react";
import type { TagDevice } from "@/lib/contracts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { QuerySettings } from "./use-atag-session";
import { errorText } from "./workspace-data";

export const ROTATION_START_MAX = 10_000_000;
export const ROTATION_COUNT_MAX = 4096;

function parseBounded(text: string, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
}

/**
 * Per-device query settings stored in this browser. Rotation is never inferred from the wall clock.
 * Mount with `key={device.id}` so state never carries over between devices.
 */
export function QuerySettingsSection({
  device,
  onLoad,
  onSave,
}: {
  device: TagDevice;
  onLoad(id: string): Promise<QuerySettings>;
  onSave(id: string, patch: Partial<QuerySettings>): Promise<void>;
}) {
  const [saved, setSaved] = useState<QuerySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [start, setStart] = useState("");
  const [count, setCount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const rotating = device.advertisingMode === "rotating";

  useEffect(() => {
    let cancelled = false;
    onLoad(device.id).then(
      (settings) => {
        if (cancelled) return;
        setSaved(settings);
        setStart(String(settings.rotationStart));
        setCount(String(settings.rotationCount));
      },
      (err) => !cancelled && setLoadError(errorText(err, "无法读取查询设置。")),
    );
    return () => {
      cancelled = true;
    };
  }, [device.id, onLoad]);

  const startValue = parseBounded(start, ROTATION_START_MAX);
  const countValue = parseBounded(count, ROTATION_COUNT_MAX);
  const invalid = rotating && (startValue === null || countValue === null);
  const dirty =
    !!saved &&
    (rotating && (startValue !== saved.rotationStart || countValue !== saved.rotationCount));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!saved || invalid || !dirty) return;
    const patch: Partial<QuerySettings> = {};
    if (rotating && startValue !== null && startValue !== saved.rotationStart) patch.rotationStart = startValue;
    if (rotating && countValue !== null && countValue !== saved.rotationCount) patch.rotationCount = countValue;
    setBusy(true);
    setMessage(null);
    try {
      await onSave(device.id, patch);
      setSaved({ ...saved, ...patch });
      setMessage({ tone: "ok", text: "已保存到此浏览器，下次刷新报告时生效。" });
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "保存失败。") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`query-${device.id}`} className="mt-5 px-4">
      <h3 id={`query-${device.id}`} className="flex items-center gap-1.5 text-sm font-semibold text-ink">
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
            {rotating && (
              <div className="grid gap-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1">
                    <span className="font-medium">起始轮换序号</span>
                    <input
                      inputMode="numeric"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
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
                      onChange={(e) => setCount(e.target.value)}
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
                  起始序号 1–{ROTATION_START_MAX.toLocaleString("en-US")}，密钥数 1–{ROTATION_COUNT_MAX}。刷新时从起始序号起依次查询这些滚动密钥；网页不会按当前时间推算序号。可参考附近管理遥测中的轮换计数调整。
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
