import type { LocationReport } from "@/lib/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Reports older than this are flagged as stale in the UI. */
export const STALE_AFTER_MS = DAY;

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff)) return "时间未知";
  if (diff < 0) return "刚刚";
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  return `${Math.floor(diff / (30 * DAY))} 个月前`;
}

const absoluteFormatter =
  typeof Intl !== "undefined"
    ? new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : null;

const shortFormatter =
  typeof Intl !== "undefined"
    ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    : null;

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return absoluteFormatter ? absoluteFormatter.format(date) : date.toISOString();
}

export function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return shortFormatter ? shortFormatter.format(date) : date.toISOString();
}

export function isStale(report: LocationReport | null, now = Date.now()): boolean {
  return !!report && now - Date.parse(report.observedAt) > STALE_AFTER_MS;
}

export function formatCoordinates(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export function formatVoltage(millivolts: number | null): string {
  return millivolts === null ? "无电压数据" : `${(millivolts / 1000).toFixed(2)} V`;
}

/** Live GATT voltages: show both volts and the raw millivolts the firmware reported. */
export function formatMillivolts(millivolts: number | null | undefined): string {
  if (millivolts === null || millivolts === undefined) return "—";
  return `${(millivolts / 1000).toFixed(2)} V（${millivolts} mV）`;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s} 秒`;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分 ${s % 60} 秒`;
}

/** m:ss countdown for the BLE session deadline. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const RESET_REASON_BITS: [number, string][] = [
  [0, "复位引脚（P0.21）"],
  [1, "看门狗"],
  [2, "软件复位"],
  [3, "CPU 锁死"],
  [16, "从 System OFF 由 GPIO 唤醒"],
  [17, "从 System OFF 由 LPCOMP 唤醒"],
  [18, "调试接口"],
  [19, "NFC 唤醒"],
];

/** nRF52832 RESETREAS bit field; 0 means power-on / brown-out reset. */
export function describeResetReason(value: number): string {
  if (!value) return "上电或掉电复位";
  const names = RESET_REASON_BITS.filter(([bit]) => (value >>> bit) & 1).map(([, label]) => label);
  const hex = `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
  return names.length ? `${names.join("、")}（${hex}）` : hex;
}

export function formatAccuracy(meters: number): string {
  return meters >= 1000 ? `±${(meters / 1000).toFixed(1)} km` : `±${Math.round(meters)} m`;
}

export function formatRotation(mode: "fixed" | "rotating" | "unset", minutes: number | null): string {
  if (mode === "unset") return "未配置密钥";
  if (mode === "fixed") return "固定密钥";
  if (!minutes) return "轮换密钥";
  return minutes % 60 === 0 ? `轮换 · 每 ${minutes / 60} 小时` : `轮换 · 每 ${minutes} 分钟`;
}
