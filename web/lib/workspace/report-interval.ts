import type { ReportRotationInterval, WorkspaceRecord } from './types.ts';

const MINUTE_MS = 60_000;
const MAX_HISTORY_MS = 30 * 24 * 60 * MINUTE_MS;
const MAX_SAMPLES = 32;
const MIN_SPAN = 4;
const TIMESTAMP_TOLERANCE_MINUTES = 1;
const CHANGE_RATIO = 0.2;

export function rotationTimingAt(record: WorkspaceRecord, now: number) {
  const timing = record.rotationTiming;
  return timing && currentObservation(record, timing.observedAt, now) ? timing : undefined;
}

function currentObservation(record: WorkspaceRecord, observedAt: string, now: number) {
  const time = Date.parse(observedAt);
  const provisioned = Date.parse(record.provisionedAt ?? '');
  return time <= now && (!(provisioned <= now) || time >= provisioned);
}

function reportIntervalAt(record: WorkspaceRecord, now: number) {
  const estimate = record.reportRotationInterval;
  return estimate && currentObservation(record, estimate.observedAt, now) ? estimate : undefined;
}

export function rotationIntervalFor(record: WorkspaceRecord, now: number) {
  const timing = rotationTimingAt(record, now);
  if (timing) return { intervalMinutes: timing.intervalMinutes, intervalSource: 'tag' as const };
  const report = reportIntervalAt(record, now);
  if (report) return { intervalMinutes: report.intervalMinutes, intervalSource: 'report' as const };
  return { intervalMinutes: record.device.rotationIntervalMinutes, intervalSource: 'profile' as const };
}

interface Sample { rotation: number; time: number }

function inferInterval(record: WorkspaceRecord, now: number) {
  const cutoff = Date.parse(record.provisionedAt ?? '');
  const samples: Sample[] = [];
  for (const report of record.reports) {
    if (report.rotation === undefined) continue;
    const time = Date.parse(report.observedAt);
    if (!(time <= now) || (cutoff <= now && time < cutoff)) continue;
    samples.push({ rotation: report.rotation, time });
  }
  samples.sort((a, b) => b.time - a.time || b.rotation - a.rotation);
  const newest = samples[0];
  if (!newest) return null;

  const accepted = [newest];
  let min = 1, max = 0xffffffff;
  let evidence: { min: number; max: number; intervalMinutes: number } | null = null;
  for (let i = 1; i < samples.length; i++) {
    const older = samples[i];
    const previous = accepted[accepted.length - 1];
    if (older.rotation > previous.rotation || newest.time - older.time > MAX_HISTORY_MS) break;
    if (older.rotation === previous.rotation) continue;

    // Observation times can fall anywhere in each round. With no stop or
    // period change, k rounds of separation bound the elapsed time to
    // (k-1)..(k+1) periods, before allowing a little clock skew.
    for (const newer of accepted) {
      const rounds = newer.rotation - older.rotation;
      const minutes = (newer.time - older.time) / MINUTE_MS;
      min = Math.max(min, Math.ceil((minutes - TIMESTAMP_TOLERANCE_MINUTES) / (rounds + 1)));
      if (rounds > 1) max = Math.min(max, Math.floor((minutes + TIMESTAMP_TOLERANCE_MINUTES) / (rounds - 1)));
    }
    if (min > max) break; // Keep only the recent run consistent with one interval.

    // A single long gap cannot establish a new period, even with many round
    // numbers between the two reports. Require two disjoint spans.
    if (accepted.some(middle => newest.rotation - middle.rotation >= MIN_SPAN && middle.rotation - older.rotation >= MIN_SPAN)) {
      const slope = (newest.time - older.time) / (newest.rotation - older.rotation) / MINUTE_MS;
      evidence = { min, max, intervalMinutes: Math.max(min, Math.min(max, Math.round(slope))) };
    }
    accepted.push(older);
    if (accepted.length >= MAX_SAMPLES) break;
  }
  return evidence && { ...evidence, observedAt: new Date(newest.time).toISOString() };
}

/** Refresh the query-only estimate when the evidence rules out a nearby stored value. */
export function updateReportRotationInterval(record: WorkspaceRecord, now: number): boolean {
  if (record.keys.kind !== 'rotating' || rotationTimingAt(record, now)) return false;
  const candidate = inferInterval(record, now);
  if (!candidate) return false;
  const saved = reportIntervalAt(record, now);
  if (saved && candidate.observedAt < saved.observedAt) return false;
  const baseline = saved?.intervalMinutes ?? record.device.rotationIntervalMinutes;
  if (baseline !== null) {
    const minimumChange = Math.max(1, baseline * CHANGE_RATIO);
    if (candidate.min - baseline < minimumChange && baseline - candidate.max < minimumChange) return false;
  }
  const estimate: ReportRotationInterval = { intervalMinutes: candidate.intervalMinutes, observedAt: candidate.observedAt };
  record.reportRotationInterval = estimate;
  return true;
}
