import { BleError } from "./ble-error.ts";
import { OTA_LAYOUT, OTA_WEB_CHUNK_BYTES, otaChunk, otaControl, type OtaPackage, type OtaProfile, type OtaStatus } from "./ota-protocol.ts";

export interface OtaProgress {
  phase: "preparing" | "transferring" | "finishing";
  received: number;
  total: number;
}

export interface OtaReceipt {
  deviceId: string;
  connectionId: number;
  previousVersion: string;
  expectedVersion: string;
  before: OtaProfile;
  /** A missing FINISH receipt can still be resolved by reading the new version after reconnect. */
  scheduled: boolean;
}

export type OtaVerification = { version: string; result: "verified" | "same_version" | "version_mismatch" | "profile_mismatch" };

export function compareOtaBoot(receipt: OtaReceipt, version: string, after: OtaProfile): OtaVerification {
  if (after.fingerprint !== receipt.before.fingerprint || after.mode !== receipt.before.mode || after.rotation < receipt.before.rotation) {
    return { version, result: "profile_mismatch" };
  }
  if (version !== receipt.expectedVersion) return { version, result: "version_mismatch" };
  return { version, result: version === receipt.previousVersion ? "same_version" : "verified" };
}

export interface OtaLink {
  readStatus(): Promise<OtaStatus>;
  subscribeStatus(listener: (status: OtaStatus) => void): Promise<() => void>;
  write(kind: "control" | "data", bytes: Uint8Array): Promise<void>;
  connected(): boolean;
  disconnect(): void;
}

const REJECTIONS: Record<number, string> = {
  1: "升级数据格式不兼容。", 2: "Tag 当前不能接受此升级操作。", 3: "写入进度与 Tag 不一致。",
  4: "Tag 写入闪存失败。", 5: "Tag 拒绝了固件签名。", 6: "Tag 拒绝了应用镜像。",
  7: "Tag 未安装 OTA 引导程序。", 8: "Tag 正在处理另一条升级命令。", 9: "Tag 电池电压低于 3.0 V，无法升级。",
};

class OtaRejected extends BleError {
  constructor(code: number) { super("write_failed", REJECTIONS[code] ?? `Tag 拒绝升级（错误 ${code}）。`); }
}

/** Wait for the application-level offset after each GATT write. Never resend an unconfirmed chunk. */
export async function transferOta(link: OtaLink, update: OtaPackage, report: (progress: OtaProgress) => void, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const image = update.image.slice();
  const total = image.length;
  report({ phase: "preparing", received: 0, total });
  const initial = await link.readStatus();
  if (!initial.installed) throw new BleError("incompatible", "Tag 未安装 OTA 引导程序。");
  const chunkSize = Math.floor(Math.min(initial.chunkSize, OTA_WEB_CHUNK_BYTES) / 4) * 4;
  if (initial.layout !== OTA_LAYOUT || chunkSize < 4) throw new BleError("incompatible", "Tag 的升级协议与固件包不兼容。");
  if (total > initial.capacity) throw new BleError("invalid_package", "应用镜像超过此 Tag 的升级容量。");
  if (initial.state !== "idle" || initial.error || initial.digestReceived || initial.received || initial.total) {
    throw new BleError("busy", "Tag 有未结束的升级会话，请重新连接后开始。");
  }

  let serial = 0;
  let latest: OtaStatus | undefined;
  let wake: (() => void) | undefined;
  const unsubscribe = await link.subscribeStatus(status => {
    latest = status;
    serial++;
    wake?.();
  });

  const exchange = async (
    kind: "control" | "data", bytes: Uint8Array, accept: (status: OtaStatus) => boolean,
    timeoutMs: number, cancel?: AbortSignal,
  ) => {
    cancel?.throwIfAborted();
    const start = serial;
    const matches = (status: OtaStatus) => {
      if (status.error) throw new OtaRejected(status.error);
      return accept(status);
    };
    const received = () => serial > start && latest !== undefined && matches(latest);
    try { await link.write(kind, bytes); }
    catch (error) {
      // A final receipt can arrive before the browser resolves its write and the Tag disconnects.
      if (received()) return;
      throw error;
    }
    const until = performance.now() + timeoutMs;
    while (true) {
      cancel?.throwIfAborted();
      if (received()) return;
      if (!link.connected()) throw new BleError("disconnected", "Tag 在确认写入前断开了连接。");
      if (performance.now() >= until) throw new BleError("timeout", "等候 Tag 确认写入超时。");
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); wake = undefined; resolve(); };
        const timer = setTimeout(done, 100);
        wake = done;
      });
      cancel?.throwIfAborted();
      if (received()) return;
      // A notification can be lost; read the live status before sending anything else.
      try { if (matches(await link.readStatus()) || received()) return; }
      catch (error) { if (received()) return; throw error; }
    }
  };

  let started = false;
  let finishing = false;
  try {
    signal?.throwIfAborted();
    started = true;
    await exchange("control", otaControl("digest", update), s => s.state === "idle" && s.digestReceived, 10_000, signal);
    const atOffset = (state: OtaStatus["state"], offset: number) => (s: OtaStatus) =>
      s.state === state && s.digestReceived && s.total === total && s.received === offset;
    await exchange("control", otaControl("begin", update), atOffset("receiving", 0), 30_000, signal);
    report({ phase: "transferring", received: 0, total });
    for (let offset = 0; offset < total; offset += chunkSize) {
      const end = Math.min(total, offset + chunkSize);
      await exchange("data", otaChunk(offset, image.subarray(offset, end)), atOffset("receiving", end), 15_000, signal);
      report({ phase: "transferring", received: end, total });
    }
    signal?.throwIfAborted();
    finishing = true;
    report({ phase: "finishing", received: total, total });
    await exchange("control", otaControl("finish", update), atOffset("ready", total), 30_000);
    return true;
  } catch (error) {
    if (finishing && !(error instanceof OtaRejected)) return false;
    // The staged image cannot be activated before FINISH. Disconnecting ends
    // the firmware's link-scoped receive session without retrying an uncertain write.
    if (started && link.connected()) link.disconnect();
    throw error;
  } finally {
    unsubscribe();
  }
}
