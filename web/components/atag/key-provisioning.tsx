"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bluetooth, CheckCircle2, Download, FileUp, FolderOpen, KeyRound, Loader2, RotateCw } from "lucide-react";
import type { AdvertisingMode, ProvisioningBundle, ProvisioningBundleRequest, TagDevice } from "@/lib/contracts";
import {
  CONFIG_LENGTH,
  decodeBase64,
  describeRejection,
  parseConfigPackage,
  type ConfigPackageSummary,
} from "@/lib/ble/protocol";
import { formatRotation } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, InlineNotice } from "./nearby-sections";
import type { NearbySession } from "./use-nearby-session";
import { errorText } from "./workspace-data";

interface LoadedPackage {
  /** Held only in component memory; dropped after commit or on close. */
  bytes: Uint8Array;
  summary: ConfigPackageSummary;
  /** "browser": keys generated into this browser's workspace; only these profiles may be bound to a serial. */
  origin: "file" | "browser";
  label: string;
  /** Set only for origin "browser". */
  profileId?: string;
  profileName?: string;
  /** True when rebuilt from an existing saved profile rather than freshly generated. */
  resumed?: boolean;
  /** Serial the saved profile is already bound to, if any. */
  profileSerial?: string | null;
}

export interface WorkspaceProvisioningProps {
  /** Real browser workspace generator; null when local storage is unavailable. */
  createBundle: ((input: ProvisioningBundleRequest) => Promise<ProvisioningBundle>) | null;
  /** Rebuilds a saved profile's package without generating keys; null when storage is unavailable. */
  getBundle: ((id: string) => Promise<ProvisioningBundle>) | null;
  /** Saved workspace profiles. */
  listProfiles: (() => Promise<TagDevice[]>) | null;
  /** Profile to preselect when opened from a draft's detail page. */
  preferredProfileId: string | null;
  confirmProvisioning(id: string, serial: string | null, firmwareVersion: string | null): Promise<void>;
  onOpenBackup(): void;
}

function sameSerial(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function provisioningStateLabel(device: Pick<TagDevice, "provisioningState">): string | null {
  if (device.provisioningState === "draft") return "草稿 · Tag 未配置";
  if (device.provisioningState === "confirmed") return "已配置";
  return null;
}

function bundleToPackage(bundle: ProvisioningBundle, profileName: string, resumed: boolean): LoadedPackage {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(bundle.configurationBase64);
  } catch {
    throw new Error("配置包编码无效。");
  }
  const parsed = parseConfigPackage(bytes);
  if (!parsed.ok) throw new Error(`配置包未通过校验：${parsed.message}`);
  if (parsed.summary.mode !== bundle.mode) throw new Error("配置包模式与档案不一致。");
  return {
    bytes,
    summary: parsed.summary,
    origin: "browser",
    label: `此浏览器 · ${profileName}`,
    profileId: bundle.deviceId,
    profileName,
    resumed,
  };
}

type Binding =
  | { status: "binding"; profileName: string }
  | { status: "bound"; profileName: string; serial: string | null }
  | { status: "failed"; profileName: string; message: string; retry: { id: string; serial: string | null; firmwareVersion: string | null } };

/** Key configuration (0001) on the shared nearby session. Requires encryption. */
export function KeyProvisioning({ session, provisioning }: { session: NearbySession; provisioning: WorkspaceProvisioningProps }) {
  const [pkg, setPkg] = useState<LoadedPackage | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [step, setStep] = useState<"package" | "confirm">("package");
  const [binding, setBinding] = useState<Binding | null>(null);
  const writing = session.task === "keys";
  const outcome = session.keysOutcome;
  const keyMode = session.snapshot.telemetry?.keyMode ?? null;
  const target = session.snapshot.deviceName ?? session.snapshot.device?.name ?? "所选 Tag";

  const bind = async (profileName: string, id: string, serial: string | null, firmwareVersion: string | null) => {
    setBinding({ status: "binding", profileName });
    try {
      await provisioning.confirmProvisioning(id, serial, firmwareVersion);
      setBinding({ status: "bound", profileName, serial });
    } catch (err) {
      setBinding({
        status: "failed",
        profileName,
        message: errorText(err, "档案更新失败。"),
        retry: { id, serial, firmwareVersion },
      });
    }
  };

  const write = async () => {
    if (!pkg || !confirmed) return;
    // Capture identity now: the Tag reboots and disconnects right after a successful commit.
    const serial = session.snapshot.identity?.serial ?? null;
    const firmwareVersion = session.snapshot.identity?.firmwareVersion ?? null;
    const written = pkg;
    if (written.profileSerial && serial && !sameSerial(written.profileSerial, serial)) {
      setPkg(null);
      setConfirmed(false);
      setStep("package");
      return; // The Tag changed since the profile was loaded; never cross-bind.
    }
    setBinding(null);
    const result = await session.applyKeys(written.bytes);
    if (result?.kind === "committed") {
      setPkg(null);
      setConfirmed(false);
      setStep("package");
      // Only a durable commit of a profile generated here may bind that profile to this physical Tag.
      if (written.origin === "browser" && written.profileId) {
        await bind(written.profileName ?? "新的 ATAG", written.profileId, serial, firmwareVersion);
      }
    }
  };

  if (outcome && !writing) {
    return (
      <Card title="配置密钥">
        <KeysOutcome session={session} />
        {binding && (
          <div className="mt-2.5">
            <BindingNotice binding={binding} onRetry={(b) => void bind(b.profileName, b.retry.id, b.retry.serial, b.retry.firmwareVersion)} />
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {outcome.kind !== "committed" && pkg && session.linkUp && (
            <Button size="sm" variant="outline" onClick={() => session.clearKeysOutcome()}>
              <ArrowLeft /> 返回确认页重试
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={binding?.status === "binding"}
            onClick={() => {
              session.clearKeysOutcome();
              setPkg(null);
              setConfirmed(false);
              setStep("package");
              setBinding(null);
            }}
          >
            换一个配置包
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title="配置密钥" aside={<span className="text-[12px] text-ink-faint">{step === "package" ? "1 / 2 · 配置包" : "2 / 2 · 确认写入"}</span>}>
      {keyMode && keyMode !== "unset" && (
        <div className="mb-3">
          <InlineNotice tone="warn">
            这个 Tag 已配置{keyMode === "rotating" ? "轮换" : "固定"}密钥。写入新配置包会替换现有密钥，原密钥对应的档案将不再收到它的报告。只想改轮换周期请用“参数”，不要重新写入密钥。
          </InlineNotice>
        </div>
      )}

      {step === "package" ? (
        <PackagePicker
          currentSerial={session.snapshot.identity?.serial ?? null}
          pkg={pkg}
          provisioning={provisioning}
          onPackage={(next) => {
            setPkg(next);
            setConfirmed(false);
          }}
        />
      ) : (
        pkg && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            <PackageSummary pkg={pkg} />
            <ul className="list-disc space-y-1 pl-5 text-ink-soft">
              <li>一次性写入完整 {CONFIG_LENGTH} 字节（带响应），然后等待设备的“密钥已提交”回执；ATT 写入成功本身不算保存成功。</li>
              <li>设备确认后会重启并开始 Find My 广播，连接随之断开属于正常现象。</li>
              <li>之后随时可以短按 Tag 打开管理窗口，无需恢复出厂。</li>
            </ul>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-paper px-3.5 py-3">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={writing}
                className="mt-0.5 size-4 accent-[var(--persimmon)]"
              />
              <span>
                我确认把此配置写入<b className="font-semibold"> {target} </b>
                （
                {session.snapshot.identity?.serial ? (
                  <>
                    序列号 <span className="font-mono">{session.snapshot.identity.serial}</span>
                  </>
                ) : (
                  "序列号尚未从遥测读取"
                )}
                ）。
              </span>
            </label>
            {writing && (
              <p role="status" className="flex items-center gap-2 text-ink-soft">
                <Loader2 className="size-4 animate-spin text-persimmon" /> 正在写入，等待本次操作的 commit 回执…
              </p>
            )}
          </div>
        )
      )}

      <div className="mt-3 flex flex-wrap justify-between gap-2">
        {step === "confirm" ? (
          <Button size="sm" variant="ghost" disabled={writing} onClick={() => setStep("package")}>
            <ArrowLeft /> 上一步
          </Button>
        ) : (
          <span />
        )}
        {step === "package" ? (
          <Button size="sm" disabled={!pkg} onClick={() => setStep("confirm")}>
            下一步
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void write()}
            disabled={!confirmed || !session.linkUp || session.busy}
            className="bg-persimmon text-white hover:bg-persimmon-ink"
          >
            {writing ? <Loader2 className="animate-spin" /> : <Bluetooth />}
            {writing ? "等待回执…" : "写入密钥"}
          </Button>
        )}
      </div>
    </Card>
  );
}

function KeysOutcome({ session }: { session: NearbySession }) {
  const outcome = session.keysOutcome!;
  if (outcome.kind === "committed") {
    const mode = outcome.status.mode;
    return (
      <div className="space-y-2 text-[13px] leading-relaxed">
        <InlineNotice tone="ok">
          密钥配置已保存到 Flash（{mode === "rotating" ? "轮换模式" : mode === "fixed" ? "固定模式" : "模式未知"}，设备回执 commit 确认）
        </InlineNotice>
        <ul className="list-disc space-y-1 pl-5 text-ink-soft">
          <li>设备会重启并恢复 Find My 广播，连接断开是正常现象。</li>
          <li>之后需要管理时，短按 Tag 打开连接窗口即可，无需恢复出厂。</li>
          <li>要确认广播已被 Apple 网络收到，请等待附近 Apple 设备上报，再连接本地桥接刷新报告。</li>
        </ul>
      </div>
    );
  }
  if (outcome.kind === "rejected") {
    return (
      <InlineNotice tone="error">
        设备拒绝了配置：{describeRejection(outcome.status.errorCode)}（错误码 {outcome.status.errorCode}）。没有保存任何内容，可换一个配置包重试。
      </InlineNotice>
    );
  }
  if (outcome.kind === "not_sent") return <InlineNotice tone="error">未发送：{outcome.message}</InlineNotice>;
  return (
    <InlineNotice tone="warn">
      配置结果未知：{outcome.message} 没有收到本次密钥操作的 commit 回执，不能认为成功。短按 Tag 重新连接并启用加密后，查看遥测中的密钥模式核对。
    </InlineNotice>
  );
}

/* ---------------- Package selection ---------------- */

function BindingNotice({ binding, onRetry }: { binding: Binding; onRetry(binding: Extract<Binding, { status: "failed" }>): void }) {
  if (binding.status === "binding") {
    return (
      <p role="status" className="flex items-center gap-2 text-[12.5px] text-ink-soft">
        <Loader2 className="size-3.5 animate-spin text-persimmon" /> 正在把档案“{binding.profileName}”标记为已配置…
      </p>
    );
  }
  if (binding.status === "bound") {
    return (
      <InlineNotice tone="ok">
        档案“{binding.profileName}”已标记为已配置
        {binding.serial ? (
          <>
            ，并绑定芯片序列号 <span className="font-mono">{binding.serial}</span>
          </>
        ) : (
          "；写入前未读到序列号，档案没有绑定序列号"
        )}
        。
      </InlineNotice>
    );
  }
  return (
    <InlineNotice tone="warn">
      <p>
        Tag 已确认保存密钥，但更新此浏览器中的档案“{binding.profileName}”失败：{binding.message}。私钥仍保存在此浏览器，可重试绑定。
      </p>
      <Button size="sm" variant="outline" className="mt-2" onClick={() => onRetry(binding)}>
        <RotateCw /> 重试
      </Button>
    </InlineNotice>
  );
}

function PackagePicker({
  currentSerial,
  pkg,
  provisioning,
  onPackage,
}: {
  /** From encrypted telemetry of the connected Tag; used to refuse profiles bound to another Tag. */
  currentSerial: string | null;
  pkg: LoadedPackage | null;
  provisioning: WorkspaceProvisioningProps;
  onPackage(pkg: LoadedPackage | null): void;
}) {
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    if (file.size !== CONFIG_LENGTH) {
      onPackage(null);
      setFileError(`配置包必须恰好 ${CONFIG_LENGTH} 字节，所选文件为 ${file.size} 字节。`);
      return;
    }
    setReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseConfigPackage(bytes);
      if (!parsed.ok) {
        onPackage(null);
        setFileError(parsed.message);
        return;
      }
      onPackage({ bytes, summary: parsed.summary, origin: "file", label: file.name });
    } catch {
      setFileError("读取文件失败。");
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] leading-relaxed text-ink-soft">配置包只在浏览器内存中使用，不会上传或打印到日志。</p>

      <SavedProfileCard provisioning={provisioning} currentSerial={currentSerial} pkg={pkg} onPackage={onPackage} />
      <BrowserKeyCard provisioning={provisioning} pkg={pkg} onPackage={onPackage} />

      <div className="rounded-xl border border-line bg-paper p-3.5">
        <div className="flex items-start gap-3">
          <FileUp className="mt-0.5 size-5 shrink-0 text-ink-soft" />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">导入 .atag-config.bin</p>
            <p className="mt-0.5 text-[12.5px] text-ink-soft">
              在可信主机上由 atagctl 生成的 {CONFIG_LENGTH} 字节配置包。私钥不在此浏览器中，写入后不会关联到“我的设备”中的任何档案。
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".bin,application/octet-stream"
              className="sr-only"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <Button variant="outline" size="sm" className="mt-2" onClick={() => fileInput.current?.click()} disabled={reading}>
              {reading ? <Loader2 className="animate-spin" /> : <FileUp />} 选择文件
            </Button>
            {fileError && <p role="alert" className="mt-2 rounded-lg bg-danger-wash px-3 py-2 text-[12.5px] text-danger">{fileError}</p>}
          </div>
        </div>
      </div>

      {pkg && <PackageSummary pkg={pkg} />}
    </div>
  );
}

/**
 * Generates keys into the browser workspace. The private keys and draft profile
 * are persisted before `onCreated` fires; the returned package is transient.
 */
export function GenerateProfileForm({
  createBundle,
  submitLabel,
  onCreated,
}: {
  createBundle: (input: ProvisioningBundleRequest) => Promise<ProvisioningBundle>;
  submitLabel: string;
  onCreated(bundle: ProvisioningBundle, profileName: string): void;
}) {
  const [name, setName] = useState("新的 ATAG");
  const [mode, setMode] = useState<AdvertisingMode>("rotating");
  const [interval, setIntervalMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    const profileName = name.trim() || "新的 ATAG";
    try {
      const bundle = await createBundle({
        name: profileName,
        mode,
        rotationIntervalMinutes: mode === "rotating" ? interval : undefined,
      });
      onCreated(bundle, profileName);
    } catch (err) {
      setError(errorText(err, "生成失败。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mt-2.5 grid gap-2.5 sm:grid-cols-[1fr_auto]">
        <label className="grid gap-1 text-[12.5px]">
          <span className="font-medium">档案昵称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            disabled={busy}
            className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-persimmon"
          />
        </label>
        <label className="grid gap-1 text-[12.5px]">
          <span className="font-medium">模式</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as AdvertisingMode)} disabled={busy} className="h-9 rounded-lg border border-input bg-background px-2 text-sm">
            <option value="rotating">轮换</option>
            <option value="fixed">固定</option>
          </select>
        </label>
        {mode === "rotating" && (
          <label className="grid gap-1 text-[12.5px] sm:col-span-2">
            <span className="font-medium">轮换周期（分钟）</span>
            <input
              type="number"
              min={1}
              max={1440}
              value={interval}
              disabled={busy}
              onChange={(e) => setIntervalMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 1)))}
              className="h-9 w-32 rounded-lg border border-input bg-background px-2.5 text-sm"
            />
          </label>
        )}
      </div>
      <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => void generate()}>
        {busy && <Loader2 className="animate-spin" />} {submitLabel}
      </Button>
      {error && <p role="alert" className="mt-2 rounded-lg bg-danger-wash px-3 py-2 text-[12.5px] text-danger">{error}</p>}
    </>
  );
}

/** Shown once a draft exists: profile created is not the same as a configured Tag. */
export function DraftCreatedNotice({ profileName, next, onOpenBackup }: { profileName: string; next: string; onOpenBackup(): void }) {
  return (
    <div className="mt-2.5 space-y-2">
      <InlineNotice tone="warn">
        档案“{profileName}”已创建，私钥已保存在此浏览器，但 <b className="font-semibold">Tag 还没有配置</b>。{next}
        私钥只在此浏览器中，建议现在就下载加密备份。
      </InlineNotice>
      <Button size="sm" variant="outline" onClick={onOpenBackup}>
        <Download /> 下载加密备份
      </Button>
    </div>
  );
}

function BrowserKeyCard({
  provisioning,
  pkg,
  onPackage,
}: {
  provisioning: WorkspaceProvisioningProps;
  pkg: LoadedPackage | null;
  onPackage(pkg: LoadedPackage | null): void;
}) {
  const { createBundle } = provisioning;
  const [error, setError] = useState<string | null>(null);
  const created = pkg?.origin === "browser" && !pkg.resumed ? pkg : null;

  return (
    <div className={cn("rounded-xl border border-line bg-paper p-3.5", !createBundle && "opacity-80")}>
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-ink-soft" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">在此浏览器生成新密钥</p>
          <p className="mt-0.5 text-[12.5px] text-ink-soft">
            {createBundle
              ? "私钥在本机生成并保存到“我的设备”，不需要 agent 或 Apple 登录。这里的名称是档案昵称，不是 Tag 的蓝牙名称。"
              : "此浏览器的本地存储不可用，无法安全保存私钥，因此不能生成。"}
          </p>
          {created ? (
            <DraftCreatedNotice
              profileName={created.profileName ?? "新的 ATAG"}
              next="请继续“下一步”写入，并等待设备的 commit 回执。"
              onOpenBackup={provisioning.onOpenBackup}
            />
          ) : (
            createBundle && (
              <GenerateProfileForm
                createBundle={createBundle}
                submitLabel="生成密钥与配置包"
                onCreated={(bundle, profileName) => {
                  setError(null);
                  try {
                    onPackage(bundleToPackage(bundle, profileName, false));
                  } catch (err) {
                    setError(`档案已保存，但${errorText(err, "配置包无效")} 可在上方“使用已保存的档案”中重试。`);
                  }
                }}
              />
            )
          )}
          {error && <p role="alert" className="mt-2 rounded-lg bg-danger-wash px-3 py-2 text-[12.5px] text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/** Resume a saved profile (draft, restored backup, import) instead of creating more private keys. */
function SavedProfileCard({
  provisioning,
  currentSerial,
  pkg,
  onPackage,
}: {
  provisioning: WorkspaceProvisioningProps;
  currentSerial: string | null;
  pkg: LoadedPackage | null;
  onPackage(pkg: LoadedPackage | null): void;
}) {
  const { listProfiles, getBundle, preferredProfileId } = provisioning;
  const [profiles, setProfiles] = useState<TagDevice[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reload when a new draft was generated so it shows up here too.
  const generatedId = pkg?.origin === "browser" && !pkg.resumed ? pkg.profileId : undefined;

  useEffect(() => {
    if (!listProfiles) return;
    let cancelled = false;
    listProfiles().then(
      (list) => {
        if (cancelled) return;
        const usable = list.filter((d) => d.capabilities.provisioning);
        setProfiles(usable);
        setSelectedId((current) => {
          if (current && usable.some((d) => d.id === current)) return current;
          const preferred = usable.find((d) => d.id === preferredProfileId) ?? usable.find((d) => d.provisioningState === "draft");
          return preferred?.id ?? usable[0]?.id ?? "";
        });
      },
      (err) => !cancelled && setError(errorText(err, "无法读取已保存的档案。")),
    );
    return () => {
      cancelled = true;
    };
  }, [listProfiles, preferredProfileId, generatedId]);

  if (!listProfiles || !getBundle || (profiles && profiles.length === 0 && !error)) return null;

  const selected = profiles?.find((d) => d.id === selectedId) ?? null;
  const boundElsewhere = !!selected?.chipSerial && !!currentSerial && !sameSerial(selected.chipSerial, currentSerial);
  const boundHere = !!selected?.chipSerial && sameSerial(selected.chipSerial, currentSerial);
  const loaded = pkg?.origin === "browser" && pkg.resumed && pkg.profileId === selectedId;

  const load = async () => {
    if (!selected || boundElsewhere) return;
    setBusy(true);
    setError(null);
    try {
      onPackage({ ...bundleToPackage(await getBundle(selected.id), selected.name, true), profileSerial: selected.chipSerial ?? null });
    } catch (err) {
      onPackage(null);
      setError(errorText(err, "无法从档案重建配置包。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-paper p-3.5">
      <div className="flex items-start gap-3">
        <FolderOpen className="mt-0.5 size-5 shrink-0 text-ink-soft" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold">使用已保存的档案</p>
          <p className="mt-0.5 text-[12.5px] text-ink-soft">
            用“我的设备”中已有档案的同一套密钥重建配置包，不会生成新私钥。适用于未写完的草稿或从备份恢复的档案。
          </p>
          {profiles === null && !error ? (
            <p className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-soft">
              <Loader2 className="size-3.5 animate-spin" /> 正在读取…
            </p>
          ) : (
            profiles &&
            profiles.length > 0 && (
              <div className="mt-2.5 space-y-2">
                <select
                  value={selectedId}
                  onChange={(e) => {
                    setSelectedId(e.target.value);
                    setError(null);
                  }}
                  disabled={busy}
                  aria-label="选择档案"
                  className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
                >
                  {profiles.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} · {formatRotation(d.advertisingMode, d.rotationIntervalMinutes)}
                      {provisioningStateLabel(d) ? ` · ${provisioningStateLabel(d)}` : ""}
                    </option>
                  ))}
                </select>
                {boundElsewhere && (
                  <InlineNotice tone="error">
                    此档案已绑定另一个 Tag（序列号 <span className="font-mono">{selected?.chipSerial}</span>），不能写入当前 Tag。
                  </InlineNotice>
                )}
                {boundHere && <InlineNotice tone="info">此档案已绑定当前 Tag，写入会重新写入同一套密钥。</InlineNotice>}
                {loaded ? (
                  <p className="flex items-center gap-1.5 text-[12.5px] text-ok">
                    <CheckCircle2 className="size-3.5" /> 已载入，可点击“下一步”。
                  </p>
                ) : (
                  <Button size="sm" variant="outline" disabled={!selected || boundElsewhere || busy} onClick={() => void load()}>
                    {busy && <Loader2 className="animate-spin" />} 载入此档案的配置包
                  </Button>
                )}
              </div>
            )
          )}
          {error && <p role="alert" className="mt-2 rounded-lg bg-danger-wash px-3 py-2 text-[12.5px] text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function PackageSummary({ pkg }: { pkg: LoadedPackage }) {
  return (
    <div className="rounded-xl border border-ok/30 bg-ok-wash/50 p-3.5">
      <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ok">
        <CheckCircle2 className="size-4" /> 配置包校验通过
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[12.5px]">
        <div>
          <dt className="text-ink-faint">来源</dt>
          <dd className="truncate text-ink">{pkg.label}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">广播模式</dt>
          <dd className="text-ink">{formatRotation(pkg.summary.mode, pkg.summary.rotationIntervalMinutes)}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">大小</dt>
          <dd className="text-ink">{pkg.summary.byteLength} 字节 · CRC32 正确</dd>
        </div>
        <div>
          <dt className="text-ink-faint">配置 ID</dt>
          <dd className="font-mono text-ink">{pkg.summary.provisioningId}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
        网页检查了文件头、版本、模式、保留字节、周期和 CRC32；密钥是否为有效 P-224 点由固件最终校验。密钥内容不会显示。
      </p>
    </div>
  );
}
