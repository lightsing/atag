import type { QuerySettings, QueryWindow, WorkspaceRecord } from './types.ts';

export const REPORT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const ROTATION_START_MAX = 10_000_000;
export const ROTATION_COUNT_MAX = 4096;
export const ROTATION_MAX = ROTATION_START_MAX + ROTATION_COUNT_MAX - 1;

export interface RotationEstimate extends QueryWindow {
  anchor: { rotation: number; observedAt: string; source: 'report' | 'tag' };
  estimatedRotation: number;
  limited: boolean;
}

export interface QuerySettingsView extends QuerySettings {
  estimate: RotationEstimate | null;
  intervalMinutes: number | null;
  intervalFromTag: boolean;
}

function timingAt(record: WorkspaceRecord, now: number) {
  const timing = record.rotationTiming;
  return timing && Date.parse(timing.observedAt) <= now ? timing : undefined;
}

export function querySettingsView(record: WorkspaceRecord, now: number): QuerySettingsView {
  const timing = timingAt(record, now);
  return {
    ...record.query,
    estimate: estimateRotation(record, now),
    intervalMinutes: timing?.intervalMinutes ?? record.device.rotationIntervalMinutes,
    intervalFromTag: !!timing,
  };
}

export function estimateRotation(record: WorkspaceRecord, now: number): RotationEstimate | null {
  if (record.keys.kind !== 'rotating') return null;
  const timing = timingAt(record, now);
  const intervalMinutes = timing?.intervalMinutes ?? record.device.rotationIntervalMinutes;
  if (!intervalMinutes) return null;

  let anchor: RotationEstimate['anchor'] | undefined;
  let anchorTime = -Infinity;
  if (timing) {
    anchor = { rotation: timing.rotation, observedAt: timing.observedAt, source: 'tag' };
    anchorTime = Date.parse(timing.observedAt);
  }
  const from = now - REPORT_LOOKBACK_MS;
  let oldestRound = Infinity;
  for (const report of record.reports) {
    if (report.rotation === undefined) continue;
    const time = Date.parse(report.observedAt);
    if (!Number.isFinite(time) || time > now) continue;
    if (time >= from) oldestRound = Math.min(oldestRound, report.rotation);
    if (time > anchorTime || (time === anchorTime && report.rotation > (anchor?.rotation ?? 0))) {
      anchor = { rotation: report.rotation, observedAt: report.observedAt, source: 'report' };
      anchorTime = time;
    }
  }
  if (!anchor || anchor.rotation > ROTATION_MAX) return null;

  const interval = intervalMinutes * 60_000;
  const elapsed = (now - anchorTime) / interval;
  // A report can land anywhere within its round. Include the measured round
  // even when it predates the lookback, since a powered-off Tag can resume it.
  const earlier = Math.ceil(Math.max(0, anchorTime - from) / interval);
  const first = Math.max(1, Math.min(oldestRound, anchor.rotation - earlier - 1));
  const last = anchor.rotation + Math.ceil(elapsed) + 1;
  const end = Math.min(last, ROTATION_MAX);
  const rotationStart = Math.min(ROTATION_START_MAX, Math.max(first, end - ROTATION_COUNT_MAX + 1));
  return {
    anchor,
    estimatedRotation: Math.min(anchor.rotation + Math.floor(elapsed), ROTATION_MAX),
    rotationStart,
    rotationCount: end - rotationStart + 1,
    limited: rotationStart > first || end < last,
  };
}
