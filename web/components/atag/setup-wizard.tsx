"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Bluetooth, FileUp, KeyRound, X } from "lucide-react";
import type { ProvisioningBundle, ProvisioningBundleRequest } from "@/lib/contracts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DraftCreatedNotice, GenerateProfileForm } from "./key-provisioning";

type Step = "method" | "prepare" | "generate";

interface SetupWizardProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Opens settings at backup restore. */
  onOpenData(): void;
  /** Real browser workspace generator; null when storage is unavailable. */
  createBundle: ((input: ProvisioningBundleRequest) => Promise<ProvisioningBundle>) | null;
  /** Hand a saved draft to the nearby panel for writing. */
  onConfigureProfile(id: string): void;
  /** Hand off to the nearby panel, which owns the only BLE session. */
  onStartNearby(): void;
}

/**
 * Entry for adding a device. Bluetooth key configuration itself runs inside
 * the nearby-management panel so identify, encrypt and write share one link.
 */
export function SetupWizard(props: SetupWizardProps) {
  const { open } = props;
  const [step, setStep] = useState<Step>("method");
  const [draft, setDraft] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (open) {
      setStep("method");
      setDraft(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(720px,calc(100dvh-24px))] flex-col gap-0 overflow-hidden rounded-2xl bg-paper p-0 sm:max-w-[560px]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <DialogTitle className="text-lg">添加设备</DialogTitle>
            <DialogDescription className="mt-1">{step === "method" ? "选择添加方式" : step === "generate" ? "在此浏览器创建密钥档案" : "蓝牙配置密钥 · 准备"}</DialogDescription>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => props.onOpenChange(false)} aria-label="关闭向导">
            <X />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
          {step === "method" ? (
            <MethodStep
              canGenerate={!!props.createBundle}
              onGenerate={() => setStep("generate")}
              onBle={() => setStep("prepare")}
              onOpenData={() => {
                props.onOpenChange(false);
                props.onOpenData();
              }}
            />
          ) : step === "generate" ? (
            <GenerateStep
              createBundle={props.createBundle}
              draft={draft}
              onCreated={setDraft}
              onOpenBackup={() => {
                props.onOpenChange(false);
                props.onOpenData();
              }}
            />
          ) : (
            <PrepareStep />
          )}
        </div>

        {step === "generate" && (
          <footer className="flex items-center justify-between gap-2 border-t border-line bg-card/60 px-5 py-3">
            <Button variant="ghost" onClick={() => setStep("method")} disabled={!!draft}>
              <ArrowLeft /> 上一步
            </Button>
            {draft ? (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => props.onOpenChange(false)}>
                  稍后配置
                </Button>
                <Button
                  onClick={() => {
                    props.onOpenChange(false);
                    props.onConfigureProfile(draft.id);
                  }}
                >
                  <Bluetooth /> 写入 Tag
                </Button>
              </div>
            ) : (
              <span />
            )}
          </footer>
        )}

        {step === "prepare" && (
          <footer className="flex items-center justify-between gap-2 border-t border-line bg-card/60 px-5 py-3">
            <Button variant="ghost" onClick={() => setStep("method")}>
              <ArrowLeft /> 上一步
            </Button>
            <Button
              onClick={() => {
                props.onOpenChange(false);
                props.onStartNearby();
              }}
            >
              <Bluetooth /> 打开附近管理
            </Button>
          </footer>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MethodStep({
  canGenerate,
  onGenerate,
  onBle,
  onOpenData,
}: {
  canGenerate: boolean;
  onGenerate(): void;
  onBle(): void;
  onOpenData(): void;
}) {
  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={onBle}
        className="flex gap-3 rounded-2xl border border-line bg-card p-4 text-left transition-colors hover:border-persimmon/50"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-persimmon-wash text-persimmon-ink">
          <Bluetooth className="size-5" />
        </span>
        <span>
          <span className="block text-[15px] font-semibold">附近蓝牙配置密钥</span>
          <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-soft">
            在此浏览器生成密钥，短按 Tag 后连接、加密并写入。不需要 agent；需要支持 Web Bluetooth 的浏览器（桌面 Chrome / Edge 或 Android Chrome）。
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onGenerate}
        disabled={!canGenerate}
        className="flex gap-3 rounded-2xl border border-line bg-card p-4 text-left transition-colors hover:border-persimmon/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-ink-soft">
          <KeyRound className="size-5" />
        </span>
        <span>
          <span className="block text-[15px] font-semibold">先创建密钥档案</span>
          <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-soft">
            {canGenerate
              ? "Tag 不在手边或浏览器不支持蓝牙也可以：现在生成并保存私钥，之后在支持蓝牙的浏览器中写入同一套密钥。不需要蓝牙或 agent。"
              : "此浏览器的本地存储不可用，无法安全保存私钥。"}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onOpenData}
        className="flex gap-3 rounded-2xl border border-line bg-card p-4 text-left transition-colors hover:border-persimmon/50"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-ink-soft">
          <FileUp className="size-5" />
        </span>
        <span>
          <span className="block text-[15px] font-semibold">从备份恢复设备</span>
          <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-soft">
            从加密备份恢复设备密钥和历史报告。文件只在浏览器内解密。
          </span>
        </span>
      </button>
    </div>
  );
}

function GenerateStep({
  createBundle,
  draft,
  onCreated,
  onOpenBackup,
}: {
  createBundle: ((input: ProvisioningBundleRequest) => Promise<ProvisioningBundle>) | null;
  draft: { id: string; name: string } | null;
  onCreated(draft: { id: string; name: string }): void;
  onOpenBackup(): void;
}) {
  if (draft) {
    return (
      <DraftCreatedNotice
        profileName={draft.name}
        next="它会以“草稿”出现在设备列表中；Tag 在手边时点“写入 Tag”，或稍后从设备详情进入。"
        onOpenBackup={onOpenBackup}
      />
    );
  }
  if (!createBundle) return <p className="text-[13.5px] text-danger">此浏览器的本地存储不可用，无法安全保存私钥。</p>;
  return (
    <div className="text-[13.5px] leading-relaxed">
      <p className="text-ink-soft">
        私钥在本机生成，保存到“我的设备”后才算完成。生成后可以不连接 Tag；配置包不会被导出，写入时从档案重建同一套密钥。
      </p>
      <GenerateProfileForm
        createBundle={createBundle}
        submitLabel="创建档案"
        // Only the profile id is kept; the transient package is dropped here.
        onCreated={(bundle, name) => onCreated({ id: bundle.deviceId, name })}
      />
    </div>
  );
}

function PrepareStep() {
  return (
    <div className="space-y-4 text-[13.5px] leading-relaxed">
      <p className="text-ink">配置密钥前请确认：</p>
      <ul className="space-y-2.5">
        <Bullet>
          未配置的 Tag 每次启动会先打开一次可连接窗口（默认 60 秒），窗口结束后等待按键；错过后<b className="font-semibold">短按一次按键</b>即可重新打开。
        </Bullet>
        <Bullet>
          连接后先按键辨认当前连接的名称。浏览器不允许读取公开的芯片序列号，启用加密后才从遥测读到，并据此关联档案。
        </Bullet>
        <Bullet>
          已经配置过的 Tag 也可以随时短按进入管理，<b className="font-semibold">不需要恢复出厂</b>；重新写入密钥会替换原密钥。
        </Bullet>
        <Bullet>
          蓝牙名称是随机的 <span className="font-mono">ATAG-XXXXXXXX</span> 或你设置的名称，网页按 ATAG 服务筛选，不再查找 ATAG-SETUP。
        </Bullet>
        <Bullet>
          密钥可在此浏览器生成（私钥保存在“我的设备”，请及时备份），也可导入可信主机上 atagctl 生成的文件。生成档案不等于 Tag 已配置：设备回报“密钥已提交到 Flash”后才算成功，随后它会重启并恢复 Find My 广播。
        </Bullet>
        <Bullet warn>长按按键（默认 5 秒）是恢复出厂：清空名称、参数和密钥，不是管理入口。</Bullet>
      </ul>
    </div>
  );
}

function Bullet({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden="true" className={cn("mt-2 size-1.5 shrink-0 rounded-full", warn ? "bg-warn" : "bg-ink-faint")} />
      <span className={cn(warn ? "text-warn" : "text-ink-soft")}>{children}</span>
    </li>
  );
}
