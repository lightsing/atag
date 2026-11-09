"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, KeyRound, Loader2, LogOut, MessageSquareText, PlugZap, RotateCw, ShieldCheck, Smartphone, X } from "lucide-react";
import type { AppleLoginPhase, AppleLoginSnapshot, AppleVerificationMethod } from "@/lib/auth/apple-login";
import { BUILTIN_ANISETTE_SOURCES, DEFAULT_ANISETTE_SOURCE, type ClientProfile } from "@/lib/preferences";
import { formatCountdown } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InlineNotice } from "./nearby-sections";
import { useNow } from "./use-nearby-session";
import type { AtagSession } from "./use-atag-session";
import { errorText } from "./workspace-data";

const CODE_LENGTH = 6;
const LOGIN_LIFETIME_SECONDS = 600;

/** Phases where a sign-in holds secrets in memory and must be cancelled on close. */
const ACTIVE_PHASES: AppleLoginPhase[] = ["authenticating", "choose_method", "sending_code", "awaiting_code", "verifying", "saving"];

export function isAppleLoginActive(phase: AppleLoginPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

/** Masks an Apple account label for display; labels already masked upstream are left alone. */
export function maskAccount(label: string | null): string | null {
  if (!label) return null;
  const value = label.trim();
  if (value.includes("*") || value.includes("•")) return value;
  const at = value.indexOf("@");
  if (at > 0) {
    const name = value.slice(0, at);
    return `${name.slice(0, Math.min(2, name.length - 1) || 1)}•••@${value.slice(at + 1)}`;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 7) return `•••• ${digits.slice(-4)}`;
  return value.length > 2 ? `${value[0]}•••${value.at(-1)}` : "•••";
}

/** Built-in Anisette source, or an HTTPS / loopback HTTP URL without credentials. */
export function anisetteSourceError(value: string): string | null {
  const v = value.trim();
  if (!v || BUILTIN_ANISETTE_SOURCES.some((source) => source === v)) return null;
  try {
    const url = new URL(v);
    if (url.username || url.password) return "地址不能包含用户名或密码。";
    if (url.hash) return "地址不能包含 #。";
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return "需使用 HTTPS，或本机回环地址的 HTTP。";
    return null;
  } catch {
    return "地址格式无效。";
  }
}

type AppleSession = Pick<
  AtagSession,
  | "workspaceReady"
  | "storageError"
  | "stats"
  | "auth"
  | "bridge"
  | "appleLogin"
  | "startAppleLogin"
  | "requestAppleCode"
  | "submitAppleCode"
  | "cancelAppleLogin"
  | "logoutApple"
>;

interface AppleAccountSectionProps {
  session: AppleSession;
  anisetteUrl: string;
  onAnisetteUrlChange(url: string): void;
  clientProfile: ClientProfile;
  onClientProfileChange(profile: ClientProfile): void;
  /** Scrolls to the bridge connection form. */
  onShowBridge(): void;
}

const inputClass =
  "h-10 w-full rounded-xl border border-input bg-card px-3 text-[13px] outline-none focus-visible:border-persimmon focus-visible:ring-2 focus-visible:ring-persimmon/25 disabled:opacity-60";

/**
 * Apple sign-in in the browser. The password proof and the verification code
 * are handled here and in the workspace controller; the bridge only supplies
 * Anisette and forwards allowlisted Apple requests.
 */
export function AppleAccountSection(props: AppleAccountSectionProps) {
  const { session } = props;
  const login = session.appleLogin;
  const bridgeConnected = session.bridge.status === "connected";
  const signedIn = session.auth?.status === "ready" || session.auth?.status === "expired";
  const expired = session.auth?.status === "expired";
  const label = maskAccount(session.auth?.accountLabel ?? null);
  const active = isAppleLoginActive(login.phase);

  /** Showing the sign-in form while a valid session exists (re-login / replace). */
  const [replacing, setReplacing] = useState(false);
  // Not secret, but never persisted; kept here so a failed attempt does not clear it.
  const [username, setUsername] = useState("");
  // The form unmounts during verification. Keep the password in this settings
  // section's memory so non-credential failures can be retried without retyping.
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "info" | "error"; text: string } | null>(null);

  const cancelRef = useRef(session.cancelAppleLogin);
  const phaseRef = useRef(login.phase);
  useEffect(() => {
    cancelRef.current = session.cancelAppleLogin;
    phaseRef.current = login.phase;
  });
  // Closing settings or navigating away never lets an unfinished sign-in complete in the background.
  useEffect(
    () => () => {
      if (isAppleLoginActive(phaseRef.current)) cancelRef.current();
    },
    [],
  );

  // Clear only on explicit credential rejection, success or cancellation.
  // Closing settings also drops this component's state; nothing is persisted.
  const previousPhase = useRef(login.phase);
  useEffect(() => {
    if (login.phase === "complete" && previousPhase.current !== "complete") {
      setReplacing(false);
      setNotice({ tone: "ok", text: "已登录。查询会话保存在此浏览器，可以下载新报告。" });
    }
    if (login.phase === "complete" || login.error?.credentialsRejected || (login.phase === "idle" && previousPhase.current !== "idle")) {
      setPassword("");
    }
    previousPhase.current = login.phase;
  }, [login.phase, login.error?.credentialsRejected]);

  const cancel = () => {
    const hadAccount = signedIn && !expired;
    session.cancelAppleLogin();
    setPassword("");
    setNotice({
      tone: "info",
      text: hadAccount ? "已取消登录，输入的密码和验证码已清除。原有登录仍然有效。" : "已取消登录，输入的密码和验证码已清除。",
    });
  };

  const showForm = !active && (!signedIn || expired || replacing);

  return (
    <section aria-labelledby="apple-title" className="space-y-3">
      <div>
        <h3 id="apple-title" className="text-sm font-semibold">Apple 账号</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
          下载 Find My 报告需要用 Apple 账号登录一次。登录在本页完成，登录结果保存在此浏览器；查看已保存的设备和历史不需要登录。
        </p>
      </div>

      {session.storageError ? (
        <InlineNotice tone="error">此浏览器的本地存储不可用，无法保存登录。</InlineNotice>
      ) : (
        <AccountStatus
          signedIn={signedIn}
          expired={expired}
          label={label}
          busy={active}
          replacing={replacing}
          onReplace={() => {
            setNotice(null);
            setReplacing(true);
          }}
          onLogout={async () => {
            setNotice(null);
            try {
              await session.logoutApple();
              setReplacing(false);
              setNotice({ tone: "ok", text: "已退出登录。设备、密钥和历史报告保留在此浏览器。" });
            } catch (err) {
              setNotice({ tone: "error", text: errorText(err, "退出登录失败。") });
            }
          }}
        />
      )}

      {!bridgeConnected && (showForm || active) && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warn/25 bg-warn-wash/70 px-3.5 py-3 text-[12.5px] text-warn">
          <PlugZap className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">登录与下载报告都需要先连接本地桥接。</p>
          <Button size="sm" variant="outline" className="bg-card" onClick={props.onShowBridge}>
            去连接
          </Button>
        </div>
      )}

      {active ? (
        <VerificationFlow login={login} session={session} hadAccount={signedIn && !expired} onCancel={cancel} />
      ) : (
        <>
          {(login.phase === "error" || login.phase === "expired") && (
            <LoginFailure login={login} keptAccount={signedIn && !expired} passwordRetained={!!password && !login.error?.credentialsRejected} />
          )}
          {showForm && (
            <SignInForm
              session={session}
              username={username}
              onUsernameChange={setUsername}
              password={password}
              onPasswordChange={setPassword}
              disabled={!bridgeConnected || !session.workspaceReady || !!session.storageError}
              replacing={replacing && signedIn && !expired}
              anisetteUrl={props.anisetteUrl}
              onAnisetteUrlChange={props.onAnisetteUrlChange}
              clientProfile={props.clientProfile}
              onClientProfileChange={props.onClientProfileChange}
              onStart={() => setNotice(null)}
              onBack={replacing ? () => {
                session.cancelAppleLogin();
                setPassword("");
                setReplacing(false);
              } : undefined}
            />
          )}
        </>
      )}

      {notice && !active && <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice>}
    </section>
  );
}

/* ---------------- Account status ---------------- */

function AccountStatus({
  signedIn,
  expired,
  label,
  busy,
  replacing,
  onReplace,
  onLogout,
}: {
  signedIn: boolean;
  expired: boolean;
  label: string | null;
  busy: boolean;
  replacing: boolean;
  onReplace(): void;
  onLogout(): Promise<void>;
}) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  if (!signedIn) {
    return (
      <div role="status" className="flex gap-2.5 rounded-xl border border-line bg-card px-3.5 py-3 text-[13px]">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-ink-faint" />
        <div className="min-w-0">
          <p className="font-semibold text-ink">未登录</p>
          <p className="mt-0.5 leading-relaxed text-ink-soft">登录后才能下载新报告。</p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        "rounded-xl border px-3.5 py-3 text-[13px]",
        expired ? "border-warn/25 bg-warn-wash/70" : "border-ok/25 bg-ok-wash/60",
      )}
    >
      <div className="flex gap-2.5">
        <ShieldCheck className={cn("mt-0.5 size-4 shrink-0", expired ? "text-warn" : "text-ok")} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">
            {expired ? "登录已失效" : "已登录"}
            {label && <span className="ml-1.5 font-mono text-[12.5px] font-normal text-ink-soft">{label}</span>}
          </p>
          <p className="mt-0.5 leading-relaxed text-ink-soft">
            {expired ? "Apple 不再接受此浏览器保存的会话，请重新登录。设备和历史不受影响。" : "会话保存在此浏览器，下载报告时经本地桥接转发给 Apple。"}
          </p>
        </div>
      </div>
      {!busy && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {!expired && !replacing && (
            <Button size="sm" variant="outline" className="bg-card" onClick={onReplace}>
              <RotateCw /> 重新登录 / 更换账号
            </Button>
          )}
          {confirmLogout ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={loggingOut}
                onClick={async () => {
                  setLoggingOut(true);
                  try {
                    await onLogout();
                  } finally {
                    setLoggingOut(false);
                    setConfirmLogout(false);
                  }
                }}
              >
                {loggingOut ? <Loader2 className="animate-spin" /> : <LogOut />} 确认退出
              </Button>
              <Button size="sm" variant="ghost" disabled={loggingOut} onClick={() => setConfirmLogout(false)}>
                取消
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:bg-danger-wash hover:text-danger"
              onClick={() => setConfirmLogout(true)}
            >
              <LogOut /> 退出登录
            </Button>
          )}
        </div>
      )}
      {confirmLogout && (
        <p className="mt-2 text-[12px] text-ink-soft">只移除此浏览器中的 Apple 查询会话；设备、密钥和历史报告保留。</p>
      )}
    </div>
  );
}

/* ---------------- Sign-in form ---------------- */

type AnisetteChoice = (typeof BUILTIN_ANISETTE_SOURCES)[number] | "url";

function SignInForm({
  session,
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  disabled,
  replacing,
  anisetteUrl,
  onAnisetteUrlChange,
  clientProfile,
  onClientProfileChange,
  onStart,
  onBack,
}: {
  session: AppleSession;
  username: string;
  onUsernameChange(value: string): void;
  password: string;
  onPasswordChange(value: string): void;
  disabled: boolean;
  replacing: boolean;
  anisetteUrl: string;
  onAnisetteUrlChange(url: string): void;
  clientProfile: ClientProfile;
  onClientProfileChange(profile: ClientProfile): void;
  onStart(): void;
  onBack?: () => void;
}) {
  const preferredSource = anisetteUrl.trim() || DEFAULT_ANISETTE_SOURCE;
  const initialChoice: AnisetteChoice = BUILTIN_ANISETTE_SOURCES.find((value) => value === preferredSource) ?? "url";
  const [choice, setChoice] = useState<AnisetteChoice>(initialChoice);
  const [customUrl, setCustomUrl] = useState(initialChoice === "url" ? anisetteUrl.trim() : "");
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const source = choice === "url" ? customUrl.trim() : choice;
  const automaticProfile = choice === DEFAULT_ANISETTE_SOURCE || choice === "sidestore";
  const urlError = choice === "url" ? (customUrl.trim() ? anisetteSourceError(customUrl) : null) : null;
  const canSubmit =
    !disabled && !session.appleLogin.busy && username.trim().length > 0 && password.length > 0 && !urlError && (choice !== "url" || !!customUrl.trim());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit || submitting.current) return;
    submitting.current = true;
    const secret = password;
    setError(null);
    onStart();
    onAnisetteUrlChange(source === DEFAULT_ANISETTE_SOURCE ? "" : source);
    try {
      await session.startAppleLogin({ username: username.trim(), password: secret, anisetteSource: source, clientProfile: automaticProfile ? "auto" : clientProfile });
    } catch (err) {
      // The controller also reflects a sanitized error in its snapshot; shown only when it has none.
      setError(errorText(err, "登录未能开始。"));
    } finally {
      submitting.current = false;
    }
  };

  return (
    <form onSubmit={submit} autoComplete="off" className="space-y-2.5 rounded-xl border border-line bg-card px-3.5 py-3 text-[12.5px]">
      <p className="flex items-center justify-between gap-2 text-[13.5px] font-semibold text-ink">
        {replacing ? "重新登录或更换账号" : "登录 Apple 账号"}
        {onBack && (
          <Button type="button" size="sm" variant="ghost" onClick={onBack}>
            取消
          </Button>
        )}
      </p>
      {replacing && <p className="text-ink-soft">新登录成功前，原有登录保持有效；失败或取消不会影响它。</p>}
      <label className="grid gap-1">
        <span className="font-medium">Apple 账号</span>
        <input
          type="email"
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          placeholder="邮箱或手机号"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          className={inputClass}
        />
      </label>
      <label className="grid gap-1">
        <span className="font-medium">密码</span>
        <input
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className={inputClass}
        />
        <span className="text-xs text-ink-faint">密码仅保留在当前设置页内存中，用于计算登录凭证，不会发送给本地桥接或写入本地存储。</span>
      </label>

      <details className="group rounded-lg border border-line bg-paper px-3 py-2">
        <summary className="cursor-pointer select-none text-[12.5px] font-medium text-ink-soft">高级选项</summary>
        <div className="mt-2 space-y-2.5">
          <fieldset className="grid gap-1">
            <legend className="mb-1 font-medium">Anisette 来源</legend>
            {([
              [DEFAULT_ANISETTE_SOURCE, "模拟 macOS（默认）", "由本地 agent 模拟 macOS CoreADI"],
              ["local", "本机系统", "在 macOS 上使用系统自带的认证组件"],
              ["portable", "便携运行库", "强制使用桥接附带的便携运行库"],
              ["sidestore", "SideStore 官方", "使用官方服务和独立机器身份"],
              ["url", "自定义服务", "填写已有 Anisette 服务地址"],
            ] as const).map(([value, title, hint]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  checked={choice === value}
                  onChange={() => {
                    setChoice(value);
                    if (value !== "url") onAnisetteUrlChange(value === DEFAULT_ANISETTE_SOURCE ? "" : value);
                    if (value === DEFAULT_ANISETTE_SOURCE || value === "sidestore") onClientProfileChange("auto");
                  }}
                  disabled={disabled}
                  className="mt-0.5 accent-[var(--persimmon)]"
                />
                <span>
                  {title}
                  <span className="ml-1.5 text-ink-faint">{hint}</span>
                </span>
              </label>
            ))}
            {choice === "url" && (
              <input
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
                placeholder="https://…"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                aria-invalid={!!urlError}
                className={cn(inputClass, "mt-1 font-mono")}
              />
            )}
            {urlError && <span className="text-xs text-danger">{urlError}</span>}
          </fieldset>
          <label className="grid gap-1">
            <span className="font-medium">客户端类型</span>
            <select
              value={automaticProfile ? "auto" : clientProfile}
              onChange={(e) => onClientProfileChange(e.target.value as ClientProfile)}
              disabled={disabled || automaticProfile}
              className={cn(inputClass, "h-9")}
            >
              <option value="auto">自动</option>
              <option value="macos">macOS</option>
              <option value="windows">Windows</option>
            </select>
            <span className="text-xs text-ink-faint">{automaticProfile ? "使用与已注册机器一致的客户端资料。" : "一般保持自动；登录被 Apple 拒绝时可尝试切换。"}</span>
          </label>
        </div>
      </details>

      <Button type="submit" size="sm" disabled={!canSubmit}>
        <KeyRound /> 登录
      </Button>
      {error && !session.appleLogin.error && <InlineNotice tone="error">{error}</InlineNotice>}
    </form>
  );
}

/* ---------------- Failure ---------------- */

function LoginFailure({ login, keptAccount, passwordRetained }: { login: AppleLoginSnapshot; keptAccount: boolean; passwordRetained: boolean }) {
  const title = login.phase === "expired" ? "验证已超时" : "登录未完成";
  const text =
    login.phase === "expired"
      ? "这次登录超过 10 分钟或验证码已失效，请重新发起登录。"
      : login.error?.message ?? "登录失败，请重试。";
  return (
    <InlineNotice tone={login.phase === "expired" ? "warn" : "error"}>
      <p className="font-semibold">{title}</p>
      <p>{text}</p>
      <p className="mt-1">
        {passwordRetained ? "密码已保留，可直接重试；验证码需重新获取。" : "请重新输入密码登录。"}
        {keptAccount && "原有登录仍然有效。"}
      </p>
    </InlineNotice>
  );
}

/* ---------------- Verification ---------------- */

function VerificationFlow({
  login,
  session,
  hadAccount,
  onCancel,
}: {
  login: AppleLoginSnapshot;
  session: AppleSession;
  hadAccount: boolean;
  onCancel(): void;
}) {
  const now = useNow(true);
  // `now` may be sampled before the sign-in started; the controller enforces the real deadline.
  const remaining = login.expiresAt ? Math.min(LOGIN_LIFETIME_SECONDS, Math.max(0, (Date.parse(login.expiresAt) - now) / 1000)) : null;
  const [code, setCode] = useState("");
  // Switching method while a code is pending; shows the list again without leaving awaiting_code.
  const [changingMethod, setChangingMethod] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  // Only ids the controller returned are ever sent; fall back when its list changes.
  const pickedId =
    picked && login.methods.some((m) => m.id === picked) ? picked : (login.selectedMethodId ?? login.methods[0]?.id ?? null);
  const [actionError, setActionError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const once = async (action: () => Promise<void>, fallback: string) => {
    if (inFlight.current || login.busy) return;
    inFlight.current = true;
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(errorText(err, fallback));
    } finally {
      inFlight.current = false;
    }
  };

  const send = (id: string | null) => {
    if (!id) return;
    setCode("");
    setChangingMethod(false);
    void once(() => session.requestAppleCode(id), "验证码发送失败。");
  };

  const submitCode = (event: React.FormEvent) => {
    event.preventDefault();
    if (code.length !== CODE_LENGTH) return;
    const value = code;
    setCode("");
    void once(() => session.submitAppleCode(value), "验证失败。");
  };

  const selected = login.methods.find((m) => m.id === login.selectedMethodId) ?? null;
  const showMethods = login.phase === "choose_method" || (login.phase === "awaiting_code" && changingMethod);
  const working = login.phase === "authenticating" || login.phase === "sending_code" || login.phase === "verifying" || login.phase === "saving";

  return (
    <div className="space-y-3 rounded-xl border border-line bg-card px-3.5 py-3 text-[12.5px]" aria-live="polite">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13.5px] font-semibold text-ink">{showMethods ? "选择验证方式" : (PHASE_TITLE[login.phase] ?? "登录中")}</p>
        {remaining !== null && (
          <span className={cn("shrink-0 font-mono text-[12px] tabular-nums", remaining <= 60 ? "text-warn" : "text-ink-faint")}>
            剩余 {formatCountdown(remaining)}
          </span>
        )}
      </div>

      {working && (
        <p role="status" className="flex items-center gap-2 text-ink-soft">
          <Loader2 className="size-4 animate-spin text-persimmon" /> {login.progress ?? WORKING_TEXT[login.phase]}
        </p>
      )}

      {showMethods && (
        <div className="space-y-2">
          <p className="text-ink-soft">选择接收验证码的方式。只有点击“发送验证码”后才会发送。</p>
          {login.methods.length === 0 ? (
            <InlineNotice tone="error">Apple 没有返回可用的验证方式。请取消后重试，或在 Apple 设备上检查账号的双重认证设置。</InlineNotice>
          ) : (
            <div role="radiogroup" aria-label="验证方式" className="grid gap-1.5">
              {login.methods.map((method) => (
                <MethodOption key={method.id} method={method} checked={pickedId === method.id} disabled={login.busy} onSelect={() => setPicked(method.id)} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!pickedId || login.busy || login.sendsRemaining <= 0} onClick={() => send(pickedId)}>
              <MessageSquareText /> 发送验证码
            </Button>
            {changingMethod && (
              <Button size="sm" variant="ghost" disabled={login.busy} onClick={() => setChangingMethod(false)}>
                <ArrowLeft /> 返回输入验证码
              </Button>
            )}
            <span className="text-ink-faint">{login.sendsRemaining > 0 ? `还可发送 ${login.sendsRemaining} 次` : "发送次数已用完，请取消后重新登录。"}</span>
          </div>
        </div>
      )}

      {login.phase === "awaiting_code" && !changingMethod && (
        <form onSubmit={submitCode} autoComplete="off" className="space-y-2">
          <p className="text-ink-soft">
            {selected
              ? selected.kind === "sms"
                ? `验证码已发送到 ${selected.label}。`
                : `请在受信任设备（${selected.label}）上允许登录并查看验证码。`
              : "请输入收到的验证码。"}
          </p>
          <label className="grid gap-1">
            <span className="font-medium">{CODE_LENGTH} 位验证码</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={CODE_LENGTH}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
              onPaste={(e) => {
                e.preventDefault();
                setCode(e.clipboardData.getData("text").replace(/\D/g, "").slice(0, CODE_LENGTH));
              }}
              disabled={login.busy}
              aria-describedby="apple-code-hint"
              className={cn(inputClass, "max-w-[200px] text-center font-mono text-[18px] tracking-[0.4em]")}
            />
            <span id="apple-code-hint" className="text-xs text-ink-faint">
              还可尝试 {login.attemptsRemaining} 次。验证码不会被保存。
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={code.length !== CODE_LENGTH || login.busy || login.attemptsRemaining <= 0}>
              <ShieldCheck /> 验证
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={login.busy || !login.selectedMethodId || login.sendsRemaining <= 0}
              onClick={() => send(login.selectedMethodId)}
            >
              <RotateCw /> 重新发送
            </Button>
            {login.methods.length > 1 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={login.busy}
                onClick={() => {
                  setCode("");
                  setChangingMethod(true);
                }}
              >
                换一种方式
              </Button>
            )}
          </div>
        </form>
      )}

      {login.error && <InlineNotice tone="error">{login.error.message}</InlineNotice>}
      {!login.error && actionError && <InlineNotice tone="error">{actionError}</InlineNotice>}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2.5">
        <p className="min-w-0 flex-1 text-[11.5px] text-ink-faint">
          {remaining !== null ? "整个登录需在 10 分钟内完成；关闭设置会取消登录。" : "关闭设置会取消登录。"}
          {hadAccount && " 原有登录在新登录成功前保持有效。"}
        </p>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X /> {login.phase === "choose_method" || login.phase === "awaiting_code" ? "返回登录" : "取消"}
        </Button>
      </div>
    </div>
  );
}

const PHASE_TITLE: Partial<Record<AppleLoginPhase, string>> = {
  authenticating: "正在登录",
  choose_method: "需要双重认证",
  sending_code: "正在发送验证码",
  awaiting_code: "输入验证码",
  verifying: "正在验证",
  saving: "正在完成登录",
};

const WORKING_TEXT: Partial<Record<AppleLoginPhase, string>> = {
  authenticating: "正在验证账号和密码…",
  sending_code: "正在请求 Apple 发送验证码…",
  verifying: "正在验证验证码…",
  saving: "正在完成登录并保存到此浏览器…",
};

function MethodOption({
  method,
  checked,
  disabled,
  onSelect,
}: {
  method: AppleVerificationMethod;
  checked: boolean;
  disabled: boolean;
  onSelect(): void;
}) {
  const Icon = method.kind === "sms" ? MessageSquareText : Smartphone;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
        checked ? "border-ink bg-paper" : "border-line hover:border-input",
      )}
    >
      <Icon className="size-4 shrink-0 text-ink-soft" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink">{method.kind === "sms" ? "短信" : "受信任设备"}</span>
        <span className="block truncate font-mono text-[12px] text-ink-soft">{method.label}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn("size-3.5 rounded-full border-2", checked ? "border-persimmon bg-persimmon shadow-[inset_0_0_0_2px_var(--card)]" : "border-input")}
      />
    </button>
  );
}
