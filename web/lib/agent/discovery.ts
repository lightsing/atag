import { ClientError } from "../client-support.ts";
import { BridgeClient, type BridgeHealth } from "./bridge-client.ts";
import ports from "./discovery-ports.json" with { type: "json" };

const PROBE_TIMEOUT_MS = 5_000;

export interface DiscoveredBridge {
  client: BridgeClient;
  health: BridgeHealth;
}

export async function discoverBridge(
  preferred: string,
  signal?: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<DiscoveredBridge | null> {
  if (signal?.aborted) throw new ClientError("CANCELLED");
  const scope = new AbortController();
  const abort = () => scope.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, PROBE_TIMEOUT_MS);
  try {
    const candidates = ports.map((port) => `http://127.0.0.1:${port}`);
    let savedUrl: string | undefined;
    if (preferred) {
      try { savedUrl = new BridgeClient(preferred, fetchImpl).baseUrl; }
      catch { /* Ignore obsolete or invalid saved URLs. */ }
    }
    const urls = [...new Set(savedUrl ? [savedUrl, ...candidates] : candidates)];
    const probes = urls.map(async (url) => {
      try {
        const client = new BridgeClient(url, fetchImpl);
        const health = await client.connect(scope.signal);
        // An explicitly saved address can still point to an older Agent without the marker.
        return health.service === "atag-agent" || url === savedUrl ? { client, health } : null;
      } catch {
        return null;
      }
    });
    for (const probe of probes) {
      const found = await probe;
      if (signal?.aborted) throw new ClientError("CANCELLED");
      if (found) return found;
    }
    return null;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    scope.abort();
  }
}
