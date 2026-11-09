import discoveryPorts from "./agent/discovery-ports.json" with { type: "json" };

/**
 * Non-sensitive preferences only (bridge address, Anisette source, client
 * profile, sort order). The Apple account name, password,
 * verification code, query session, keys, configuration bytes and report data
 * are never written here; user data lives in the browser workspace.
 */
export type ClientProfile = "auto" | "macos" | "windows";
export const DEFAULT_ANISETTE_SOURCE = "mac-coreadi";
export const BUILTIN_ANISETTE_SOURCES = [DEFAULT_ANISETTE_SOURCE, "local", "portable", "sidestore"] as const;

export interface Preferences {
  agentUrl: string;
  /** Empty uses the default; otherwise a built-in Anisette source or a service URL. */
  anisetteUrl: string;
  clientProfile: ClientProfile;
  sort: "recent" | "name";
}

const KEY = "atag.preferences.v1";
export const DEFAULT_AGENT_URL = `http://127.0.0.1:${discoveryPorts[0]}`;
const DEFAULTS: Preferences = { agentUrl: "", anisetteUrl: "", clientProfile: "auto", sort: "recent" };
const PROFILES: ClientProfile[] = ["auto", "macos", "windows"];

export function loadPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      agentUrl: typeof parsed.agentUrl === "string" ? parsed.agentUrl : DEFAULTS.agentUrl,
      anisetteUrl: typeof parsed.anisetteUrl === "string" ? parsed.anisetteUrl : DEFAULTS.anisetteUrl,
      clientProfile: PROFILES.includes(parsed.clientProfile as ClientProfile) ? (parsed.clientProfile as ClientProfile) : DEFAULTS.clientProfile,
      sort: parsed.sort === "name" ? "name" : "recent",
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePreferences(next: Preferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ agentUrl: next.agentUrl, anisetteUrl: next.anisetteUrl, clientProfile: next.clientProfile, sort: next.sort }),
    );
  } catch {
    /* storage unavailable (private mode); preferences stay in memory */
  }
}
