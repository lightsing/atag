/** Errors, bridge address validation and browser operation polling. */
import type {WorkspaceClient,ClientFailure,WorkspaceOperation,ErrorCode} from "./contracts";

export const OPERATION_POLL_INTERVAL_MS = 1_000;
export const OPERATION_POLL_LIMIT_MS = 60_000;
export const MAX_REPORT_PAGE = 200;

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  AGENT_UNAVAILABLE:
    "无法连接本地 agent。可能是 agent 未启动、地址错误，或被浏览器的 CORS、混合内容、本地网络访问策略阻止。",
  TIMEOUT: "本地 agent 响应超时。",
  UNAUTHORIZED: "agent 拒绝了当前网页的来源或主机，请检查桥接地址与允许的 Origin。",
  AUTH_REQUIRED: "请先在网页中登录 Apple 账号。",
  AUTH_EXPIRED: "Apple 登录已过期，请在网页重新登录。",
  NOT_FOUND: "此浏览器中找不到这个设备或任务。",
  INVALID_REQUEST: "请求参数无效。",
  VERSION_MISMATCH: "本地 agent 协议版本与网页不兼容。",
  CAPABILITY_UNSUPPORTED: "当前 agent 尚未实现这个功能。",
  UPSTREAM_UNAVAILABLE: "agent 暂时无法访问上游服务，请稍后重试。",
  INTERNAL_ERROR: "本地 agent 返回了未知错误。",
  CANCELLED: "请求已取消。",
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "AGENT_UNAVAILABLE", "TIMEOUT", "UPSTREAM_UNAVAILABLE",
]);

export class ClientError extends Error implements ClientFailure {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(code: ErrorCode, message?: string, options: { retryable?: boolean; status?: number | null } = {}) {
    super(message || DEFAULT_MESSAGES[code]);
    this.name = "ClientError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.status = options.status ?? null;
  }
}

/** Normalise anything thrown by an adapter into an `ClientError`. */
export function toClientError(error: unknown): ClientError {
  if (error instanceof ClientError) return error;
  if (error && typeof error === "object" && "name" in error && (error as { name: string }).name === "AbortError") {
    return new ClientError("CANCELLED");
  }
  return new ClientError("INTERNAL_ERROR");
}

export type BaseUrlResult = { ok: true; url: string } | { ok: false; message: string };

export function validateAgentBaseUrl(input: string): BaseUrlResult {
  const value = input.trim();
  if (!value) return { ok: false, message: "请填写 agent 地址，例如 http://127.0.0.1:18432" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "地址格式无效，需要包含 http:// 或 https://" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "只支持 http 或 https 地址。" };
  }
  if (url.username || url.password) return { ok: false, message: "地址中不能包含用户名或密码。" };
  if (url.search || value.includes("?")) return { ok: false, message: "地址中不能包含查询参数。" };
  if (url.hash || value.includes("#")) return { ok: false, message: "地址中不能包含 # 片段。" };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.origin}${path}` };
}

export interface PollOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  limitMs?: number;
  onUpdate?: (operation: WorkspaceOperation) => void;
  now?: () => number;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ClientError("CANCELLED"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ClientError("CANCELLED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const isPending = (operation: WorkspaceOperation) => operation.status === "queued" || operation.status === "running";

/**
 * Poll an operation every second until it is terminal. Gives up after 60 s
 * with TIMEOUT (the browser task may still finish later); abort → CANCELLED.
 */
export async function pollOperation(
  client: Pick<WorkspaceClient, "getOperation">,
  initial: WorkspaceOperation,
  options: PollOptions = {},
): Promise<WorkspaceOperation> {
  const {
    signal,
    intervalMs = OPERATION_POLL_INTERVAL_MS,
    limitMs = OPERATION_POLL_LIMIT_MS,
    onUpdate,
    now = () => Date.now(),
  } = options;
  const started = now();
  let operation = initial;
  while (isPending(operation)) {
    if (now() - started >= limitMs) {
      throw new ClientError("TIMEOUT", "刷新任务超过 60 秒仍未完成，已停止等待。稍后可再次刷新查看。");
    }
    await abortableDelay(intervalMs, signal);
    operation = await client.getOperation(operation.id, signal);
    onUpdate?.(operation);
  }
  return operation;
}
