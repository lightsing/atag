"use client";

import { useRef, useState } from "react";
import { ArrowUpCircle, Loader2, RefreshCw } from "lucide-react";
import { OTA_LAYOUT, OTA_MAX_FILE_BYTES, OTA_MIN_BATTERY_MV, parseOtaPackage, type OtaPackage } from "@/lib/ble/ota-protocol";
import { formatMillivolts } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, Fact, InlineNotice } from "./nearby-sections";
import type { NearbySession } from "./use-nearby-session";

export function OtaSection({ session }: { session: NearbySession }) {
  const [update, setUpdate] = useState<OtaPackage | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const selection = useRef(0);
  const { snapshot, ota } = session;
  const status = snapshot.otaStatus;
  const version = session.linkUp ? snapshot.identity?.firmwareVersion : null;
  const battery = session.linkUp ? snapshot.batteryMillivolts : null;
  const blocked = !session.linkUp ? "短按 Tag 的按键，再在上方选择并连接设备。"
    : !status ? "当前固件未提供兼容的 OTA 接口。"
    : !status.installed ? "此 Tag 未安装 OTA 引导程序，暂不能通过蓝牙升级。"
    : status.layout !== OTA_LAYOUT || status.chunkSize < 4 ? "此 Tag 的升级协议与固件包不兼容。"
    : status.state !== "idle" || status.error || status.digestReceived ? "Tag 有未结束的升级会话，请重新连接。"
    : battery !== null && battery < OTA_MIN_BATTERY_MV ? "电池电压低于 3.0 V，请先更换电池。"
    : update && update.image.length > status.capacity ? "固件镜像超过此 Tag 的升级容量。" : null;

  const load = async (file: File | undefined) => {
    const id = ++selection.current;
    setUpdate(null);
    setFileError(null);
    setLoading(!!file);
    if (!file) return;
    try {
      if (file.size > OTA_MAX_FILE_BYTES) throw new Error("固件包超过大小上限。");
      const parsed = parseOtaPackage(await file.text());
      if (id === selection.current) setUpdate(parsed);
    } catch (error) {
      if (id === selection.current) setFileError(error instanceof Error ? error.message : "无法读取固件包。");
    } finally {
      if (id === selection.current) setLoading(false);
    }
  };

  const upgrading = session.task === "ota";
  return (
    <Card title="固件升级">
      <div className="space-y-3 text-[13px]">
        <p className="text-ink-soft">选择签名的 .atag-ota 固件包，通过蓝牙更新 Tag。升级期间请保持网页打开并让 Tag 靠近。</p>
        {session.linkUp && (
          <dl className="grid grid-cols-2 gap-2 rounded-xl bg-muted px-3 py-2.5">
            <Fact label="已连接的 Tag" value={snapshot.deviceName ?? snapshot.device?.name ?? "ATAG"} />
            <Fact label="当前固件" value={version || "未知"} />
            <Fact label="电池电压" value={formatMillivolts(battery)} />
            {update && <Fact label="固件包版本" value={`${update.version} · 签名已校验`} />}
          </dl>
        )}
        <label className="grid gap-1.5">
          <span className="font-medium">固件包</span>
          <input
            type="file"
            accept=".atag-ota"
            onChange={(event) => void load(event.currentTarget.files?.[0])}
            disabled={upgrading}
            className="w-full rounded-lg border border-input bg-background text-[12.5px] text-ink-soft file:mr-3 file:cursor-pointer file:border-0 file:bg-muted file:px-3 file:py-2 file:font-medium file:text-ink disabled:opacity-50"
          />
        </label>
        {loading && <p role="status" className="text-ink-soft">正在校验固件包…</p>}
        {fileError && <InlineNotice tone="error">{fileError}</InlineNotice>}
        {update && !session.linkUp && <p className="text-ink-soft">固件包 {update.version}，签名已校验。</p>}
        {!upgrading && blocked && <p className="text-ink-soft">{blocked}</p>}

        {ota?.kind === "progress" && (() => {
          const { phase, received, total } = ota.progress;
          const phaseLabel = phase === "preparing" ? `正在准备升级到 ${ota.version}…` : phase === "finishing" ? "Tag 正在校验镜像并安排重启…" : `正在写入固件 ${ota.version}…`;
          return (
            <div className="space-y-1.5 rounded-xl bg-muted px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span role="status" className="font-medium">{phaseLabel}</span>
                <span className="tabular-nums">{Math.floor(received * 100 / total)}%</span>
              </div>
              <progress aria-label="固件写入进度" value={received} max={total} className="h-2 w-full accent-persimmon" />
              <p className="text-[12px] tabular-nums text-ink-soft">已写入 {(received / 1024).toFixed(1)} / {(total / 1024).toFixed(1)} KiB</p>
            </div>
          );
        })()}

        {ota?.kind === "verifying" && (
          <InlineNotice tone="info">{ota.receipt.scheduled ? "Tag 已确认安装排程。" : "未收到安装确认。"}正在等待重启并重连核验…</InlineNotice>
        )}
        {ota?.kind === "pending" && (
          <InlineNotice tone="warn">
            {ota.receipt.scheduled ? "Tag 已确认安装排程，重启结果尚未核验。" : "升级结果尚未确认。"}
            {ota.message} 等待 Tag 重启后，可短按按键再核验。
          </InlineNotice>
        )}
        {ota?.kind === "checked" && <VerificationNotice ota={ota} />}
        {ota?.kind === "failed" && <InlineNotice tone="error">升级未完成。{ota.message}</InlineNotice>}
        {ota?.kind === "cancelled" && <InlineNotice tone="info">已取消上传，未请求安装。</InlineNotice>}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={session.busy || loading || !update || !!blocked || ota?.kind === "pending"}
            onClick={() => update && session.uploadFirmware(update)}
          >
            {upgrading ? <Loader2 className="animate-spin" /> : <ArrowUpCircle />} 开始升级
          </Button>
          {ota?.kind === "progress" && ota.progress.phase !== "finishing" && (
            <Button size="sm" variant="outline" onClick={session.cancelFirmwareUpload}>取消上传</Button>
          )}
          {ota?.kind === "pending" && (
            <Button size="sm" variant="outline" onClick={session.verifyFirmware} disabled={session.busy || snapshot.device?.id !== ota.receipt.deviceId}>
              <RefreshCw /> 重连核验
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function VerificationNotice({ ota }: { ota: Extract<NearbySession["ota"], { kind: "checked" }> }) {
  const { version, result } = ota.verification;
  if (result === "verified") return <InlineNotice tone="ok">已升级到 {version}，设备配置核验通过。</InlineNotice>;
  if (result === "same_version") return <InlineNotice tone="warn">重连后版本仍为 {version}，配置核验通过。同版本无法确认是否换成了新镜像。</InlineNotice>;
  if (result === "profile_mismatch") return <InlineNotice tone="error">重连后读取到版本 {version}，但设备配置或密钥轮次与升级前不符。</InlineNotice>;
  return <InlineNotice tone="warn">Tag 回报版本 {version}，未核验到目标版本 {ota.receipt.expectedVersion}。</InlineNotice>;
}
