"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, Loader2, PlugZap, ShieldAlert, X, XCircle } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { validateAgentBaseUrl } from "@/lib/client-support";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DEFAULT_AGENT_URL, type ClientProfile } from "@/lib/preferences";
import { AppleAccountSection, isAppleLoginActive } from "./apple-login";
import type { AtagSession, BridgeConnection } from "./use-atag-session";
import { WorkspaceDataSection } from "./workspace-data";

export type SettingsFocus = "bridge" | "apple" | "data";

const FOCUS_IDS: Record<SettingsFocus, string> = { bridge: "bridge-title", apple: "apple-title", data: "data-title" };

function scrollTo(focus: SettingsFocus) {
  document.getElementById(FOCUS_IDS[focus])?.scrollIntoView({ block: "start", behavior: "smooth" });
}

interface SettingsSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  side: "right" | "bottom";
  /** Scroll to this section when opened. */
  focus: SettingsFocus | null;
  session: AtagSession;
  agentUrl: string;
  onAgentUrlChange(url: string): void;
  anisetteUrl: string;
  onAnisetteUrlChange(url: string): void;
  clientProfile: ClientProfile;
  onClientProfileChange(profile: ClientProfile): void;
  onConnect(url?: string): Promise<boolean>;
}

const ERROR_TITLES: Partial<Record<string, string>> = {
  AGENT_UNAVAILABLE: "无法连接",
  TIMEOUT: "连接超时",
  VERSION_MISMATCH: "版本不兼容",
  UNAUTHORIZED: "来源被拒绝",
  INVALID_REQUEST: "地址无效",
};

export function SettingsSheet(props: SettingsSheetProps) {
  const { session } = props;
  const { bridge } = session;
  const [url, setUrl] = useState(props.agentUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => setUrl(props.agentUrl), [props.agentUrl]);

  useEffect(() => {
    if (!props.open || !props.focus) return;
    const timer = setTimeout(() => scrollTo(props.focus!), 150);
    return () => clearTimeout(timer);
  }, [props.open, props.focus]);

  // Closing settings cancels an unfinished sign-in and drops its secrets; a finished one stays.
  const onOpenChange = (next: boolean) => {
    if (!next && isAppleLoginActive(session.appleLogin.phase)) session.cancelAppleLogin();
    props.onOpenChange(next);
  };

  const connecting = bridge.status === "connecting";
  const connected = bridge.status === "connected";

  const test = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const checked = validateAgentBaseUrl(url);
    if (!checked.ok) {
      setUrlError(checked.message);
      return;
    }
    setUrlError(null);
    setUrl(checked.url);
    if (await props.onConnect(checked.url)) {
      props.onAgentUrlChange(checked.url);
      setManual(false);
    }
  };

  return (
    // Password managers mount their UI outside the sheet. A modal Radix dialog
    // disables those pointer events and traps their focus; use our own backdrop
    // so the page stays covered while extension popups remain interactive.
    <Sheet open={props.open} onOpenChange={onOpenChange} modal={false}>
      <SheetPrimitive.Portal>
        <div
          data-slot="settings-overlay"
          aria-hidden="true"
          className="fixed inset-0 z-50 bg-black/50"
          onPointerDown={(event) => {
            if (event.button !== 0 || event.ctrlKey) return;
            event.preventDefault();
            onOpenChange(false);
          }}
        />
      </SheetPrimitive.Portal>
      <SheetContent
        side={props.side}
        showCloseButton={false}
        // Outside extension clicks/focus must not dismiss settings and cancel login.
        // The backdrop, close button and Escape handle dismissal explicitly.
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus({ preventScroll: true });
        }}
        className={cn(
          "gap-0 bg-paper",
          props.side === "right" ? "w-full sm:max-w-[420px]" : "max-h-[92dvh] rounded-t-3xl",
        )}
      >
        <SheetHeader className="flex-row items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <SheetTitle className="text-lg">设置</SheetTitle>
            <SheetDescription>本地桥接、Apple 账号、数据与备份</SheetDescription>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => onOpenChange(false)} aria-label="关闭设置">
            <X />
          </Button>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 scrollbar-thin">
          <section aria-labelledby="bridge-title" className="space-y-4">
            <div>
              <h3 id="bridge-title" className="text-sm font-semibold">本地桥接</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-soft">
                登录 Apple 账号和下载新报告都需要它。本机运行的 atag-agent 只提供 Anisette 并转发发往 Apple 的请求，不保存账号、会话、设备或密钥；报告在浏览器内解密。未连接时仍可查看设备、历史并生成新密钥。
              </p>
            </div>
            <BridgeCard bridge={bridge} hasAccount={session.auth?.status === "ready"} />

            {!connecting && (bridge.status === "error" || manual) && (
              <form onSubmit={test} className="space-y-3">
                <div className="grid gap-1.5">
                  <label htmlFor="agent-url" className="text-[13px] font-medium">地址</label>
                  <input
                    id="agent-url"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setUrlError(null);
                    }}
                    placeholder={DEFAULT_AGENT_URL}
                    inputMode="url"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={!!urlError}
                    aria-describedby="agent-url-hint"
                    className="h-10 rounded-xl border border-input bg-card px-3 font-mono text-[13px] outline-none focus-visible:border-persimmon focus-visible:ring-2 focus-visible:ring-persimmon/25"
                  />
                  <p id="agent-url-hint" className={cn("text-xs", urlError ? "text-danger" : "text-ink-faint")}>
                    {urlError ?? "填写 Agent 显示的本机地址，支持 127.0.0.1、localhost 和 [::1]。"}
                  </p>
                </div>
                <Button type="submit"><PlugZap /> 手动连接</Button>
              </form>
            )}

            <div className="flex flex-wrap gap-2">
              {connecting ? (
                <Button type="button" variant="outline" onClick={session.cancelBridgeConnect}>取消连接</Button>
              ) : connected ? (
                <Button type="button" variant="outline" onClick={session.disconnectBridge}>断开</Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => { setManual(false); void props.onConnect(); }}>
                  <PlugZap /> 重新探测
                </Button>
              )}
              {!connecting && !manual && bridge.status !== "error" && (
                <Button type="button" variant="ghost" onClick={() => setManual(true)}>手动指定地址</Button>
              )}
            </div>

            <div className="rounded-xl border border-line bg-card px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-soft">
              <p className="font-medium text-ink">关于浏览器限制</p>
              <p className="mt-1">
                如果浏览器询问是否允许访问本地网络，请允许后重新探测。发布版托盘已允许访问随附的网页地址。自行运行 CLI 时，需要用
                --allow-origin 允许本页的 Origin。
              </p>
            </div>
          </section>

          <AppleAccountSection
            session={session}
            anisetteUrl={props.anisetteUrl}
            onAnisetteUrlChange={props.onAnisetteUrlChange}
            clientProfile={props.clientProfile}
            onClientProfileChange={props.onClientProfileChange}
            onShowBridge={() => scrollTo("bridge")}
          />

          <WorkspaceDataSection session={session} />

          <section aria-labelledby="about-title" className="rounded-xl border border-line bg-card px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-soft">
            <h3 id="about-title" className="font-medium text-ink">当前能力边界</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>设备档案、私钥、查询设置与历史报告归此浏览器所有；新密钥在浏览器内生成，不需要 agent。</li>
              <li>启动托盘或 atag-agent serve 后，网页会探测本地桥接。找不到时可重新探测或手动填入地址。</li>
              <li>Apple 登录在本页完成：密码凭证在浏览器内计算，验证码在本页输入，登录结果只保存在此浏览器。</li>
              <li>附近管理（固件 0.1.0）：短按 Tag 后可连接辨认、读电压与遥测、改名、调参数、配置密钥、重启或恢复出厂，与桥接状态无关。</li>
              <li>附近管理不提供坐标；地图中的报告来自 Find My 网络，不代表 Tag 在附近。</li>
              <li>没有响铃、OTA、GPS 坐标读取或精确寻找功能。</li>
            </ul>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function BridgeCard({ bridge, hasAccount }: { bridge: BridgeConnection; hasAccount: boolean }) {
  if (bridge.status === "connecting") {
    return <StatusCard icon={<Loader2 className="size-4 animate-spin text-persimmon" />} title="连接中" text={bridge.discovering ? "正在探测本地 Agent…" : "正在检查桥接版本与能力…"} />;
  }
  if (bridge.status === "connected") {
    const { health } = bridge;
    return (
      <StatusCard
        tone={hasAccount ? "ok" : "warn"}
        icon={hasAccount ? <CheckCircle2 className="size-4 text-ok" /> : <ShieldAlert className="size-4 text-warn" />}
        title={`桥接可达 · atag-agent ${health.agentVersion}`}
        text={hasAccount ? "可以下载新报告。" : "桥接已连接。登录 Apple 账号后即可下载新报告。"}
        extra={`${bridge.url} · 协议 v${health.protocolVersion}`}
      />
    );
  }
  if (bridge.status === "error") {
    return (
      <StatusCard
        tone="danger"
        icon={<XCircle className="size-4 text-danger" />}
        title={ERROR_TITLES[bridge.error.code] ?? "连接失败"}
        text={bridge.error.message}
        extra={`错误代码 ${bridge.error.code}${bridge.error.retryable ? " · 可重试" : ""}`}
      />
    );
  }
  return <StatusCard icon={<CircleDashed className="size-4 text-ink-faint" />} title="未连接" text="启动本地 Agent 后可重新探测。" />;
}

function StatusCard({
  icon,
  title,
  text,
  extra,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  extra?: string;
  tone?: "neutral" | "ok" | "warn" | "danger";
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex gap-2.5 rounded-xl border px-3.5 py-3",
        tone === "neutral" && "border-line bg-card",
        tone === "ok" && "border-ok/25 bg-ok-wash/60",
        tone === "warn" && "border-warn/25 bg-warn-wash/70",
        tone === "danger" && "border-danger/20 bg-danger-wash/70",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 text-[13px]">
        <p className="font-semibold text-ink">{title}</p>
        <p className="mt-0.5 leading-relaxed text-ink-soft">{text}</p>
        {extra && <p className="mt-1 font-mono text-[11.5px] text-ink-faint">{extra}</p>}
      </div>
    </div>
  );
}
