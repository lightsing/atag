"use client";

import { useEffect, useState } from "react";
import type { WorkspaceClient, LocationReport } from "@/lib/contracts";
import { type ClientError, MAX_REPORT_PAGE, toClientError } from "@/lib/client-support";

export type HistoryRange = "24h" | "7d";

/** Upper bound on pages fetched for one view; the UI says so when reached. */
const MAX_PAGES = 10;

export interface ReportsState {
  status: "idle" | "loading" | "ready" | "error";
  reports: LocationReport[];
  /** True when more pages exist than we fetched. */
  truncated: boolean;
  error: ClientError | null;
}

const IDLE: ReportsState = { status: "idle", reports: [], truncated: false, error: null };

export function useReports(
  client: WorkspaceClient | null,
  deviceId: string | null,
  range: HistoryRange,
  version: number,
  retryToken: number,
): ReportsState {
  const [state, setState] = useState<ReportsState>(IDLE);

  useEffect(() => {
    if (!client || !deviceId) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    const to = new Date();
    const from = new Date(to.getTime() - (range === "24h" ? 24 : 24 * 7) * 3_600_000);
    // Never show the previous device's history while a different query loads.
    setState({ status: "loading", reports: [], truncated: false, error: null });

    void (async () => {
      const collected: LocationReport[] = [];
      let cursor: string | undefined;
      let truncated = false;
      try {
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES) {
            truncated = true;
            break;
          }
          const result = await client.listReports(
            deviceId,
            { from: from.toISOString(), to: to.toISOString(), cursor, limit: MAX_REPORT_PAGE },
            controller.signal,
          );
          collected.push(...result.reports);
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
        if (controller.signal.aborted) return;
        collected.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
        setState({ status: "ready", reports: collected, truncated, error: null });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ status: "error", reports: [], truncated: false, error: toClientError(error) });
      }
    })();

    return () => controller.abort();
  }, [client, deviceId, range, version, retryToken]);

  return state;
}
