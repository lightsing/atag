import { ClientError } from "../client-support.ts";
import { BridgeClient, type BridgeHealth } from "./bridge-client.ts";
import ports from "./discovery-ports.json" with { type: "json" };

const PROBE_TIMEOUT_MS = 5_000;

export interface DiscoveredBridge {
  client: BridgeClient;
  health: BridgeHealth;
}

interface DiscoveryOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  onPermissionPending?: (pending: boolean) => void;
}

async function loopbackPermission(): Promise<PermissionStatus | undefined> {
  const host = globalThis.location?.hostname;
  const permissions = globalThis.navigator?.permissions;
  // Pages already served from loopback can reach Agent without this prompt.
  if (!permissions || host === "localhost" || host === "127.0.0.1" || host === "[::1]") return;
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      return await permissions.query({ name } as PermissionDescriptor);
    } catch {
      // Older Chrome uses the combined permission. Other browsers may support neither.
    }
  }
}

export async function discoverBridge(
  preferred: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveredBridge | null> {
  const { signal, onPermissionPending } = options;
  if (signal?.aborted) throw new ClientError("CANCELLED");
  const permission = await loopbackPermission();
  if (signal?.aborted) throw new ClientError("CANCELLED");
  const prompted = permission?.state === "prompt";
  let found: DiscoveredBridge | null = null;
  if (prompted) {
    onPermissionPending?.(true);
    found = await probe(preferred, options, permission);
  }

  if (permission?.state === "denied") {
    throw new ClientError("AGENT_UNAVAILABLE", "浏览器已阻止访问本机服务。请在站点设置中允许访问本地网络，再重新探测。");
  }
  if (found || (prompted && permission.state === "prompt")) return found;
  if (prompted) onPermissionPending?.(false);
  return probe(preferred, options);
}

async function probe(
  preferred: string,
  { signal, fetch: fetchImpl }: DiscoveryOptions,
  pending?: PermissionStatus,
): Promise<DiscoveredBridge | null> {
  if (signal?.aborted) throw new ClientError("CANCELLED");
  const scope = new AbortController();
  const abort = () => scope.abort();
  const onDecision = () => {
    if (pending?.state !== "prompt") abort();
  };
  signal?.addEventListener("abort", abort, { once: true });
  pending?.addEventListener("change", onDecision);
  // Keep requests alive while the browser prompts. A grant starts a fresh, timed scan.
  const deadline = pending ? undefined : setTimeout(abort, PROBE_TIMEOUT_MS);
  try {
    if (pending && pending.state !== "prompt") return null;
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
        const health = await client.connect(scope.signal, null);
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
    pending?.removeEventListener("change", onDecision);
    signal?.removeEventListener("abort", abort);
    scope.abort();
  }
}
