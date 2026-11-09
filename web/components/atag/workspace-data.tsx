"use client";

import { useRef, useState } from "react";
import { Download, FileUp, Loader2, Upload } from "lucide-react";
import { toClientError } from "@/lib/client-support";
import { absoluteTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { InlineNotice } from "./nearby-sections";
import type { AtagSession, BackupPreview } from "./use-atag-session";

/** Larger files are refused before reading; real backups are far smaller. */
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MIN_PASSWORD = 8;

export function errorText(error: unknown, fallback = "操作失败。"): string {
  if (error && typeof error === "object" && "code" in error) return toClientError(error).message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

async function readTextFile(file: File): Promise<string> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error(`文件过大（${Math.round(file.size / 1024 / 1024)} MB），已拒绝读取。`);
  return file.text();
}

function backupFileName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `atag-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser a moment to start the download, then drop the encrypted blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const inputClass =
  "h-10 w-full rounded-xl border border-input bg-card px-3 text-[13px] outline-none focus-visible:border-persimmon focus-visible:ring-2 focus-visible:ring-persimmon/25";

type DataSession = Pick<
  AtagSession,
  | "workspaceReady"
  | "storageError"
  | "stats"
  | "exportBackup"
  | "previewBackup"
  | "restoreBackup"
>;

/** Browser-owned data: storage notice, encrypted backup / restore. */
export function WorkspaceDataSection({ session }: { session: DataSession }) {
  const { stats, storageError } = session;
  return (
    <section aria-labelledby="data-title" className="space-y-3">
      <h3 id="data-title" className="text-sm font-semibold">数据与备份</h3>
      {storageError ? (
        <InlineNotice tone="error">{storageError.message}</InlineNotice>
      ) : (
        <div className="rounded-xl border border-line bg-card px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-soft">
          <p className="font-medium text-ink">
            此浏览器保存了 {stats ? `${stats.deviceCount} 台设备 · ${stats.reportCount} 条报告` : "…"}
          </p>
          <p className="mt-1">
            设备档案、私钥、查询设置、历史报告和 Apple 登录会话保存在本站点的浏览器存储中；下载报告时只把公开哈希和登录会话交给你连接的本地桥接转发，私钥和解密后的位置不离开浏览器。浏览器存储没有额外密码保护，清除网站数据或换设备会连同私钥一起丢失，请定期下载加密备份。
          </p>
        </div>
      )}
      <BackupExport session={session} />
      <BackupRestore session={session} />
    </section>
  );
}

function BackupExport({ session }: { session: DataSession }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [includeAccount, setIncludeAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canExport = session.workspaceReady && !session.storageError && password.length >= MIN_PASSWORD && confirm === password && !busy;

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canExport) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const text = await session.exportBackup(password, includeAccount);
      const name = backupFileName();
      download(text, name);
      setPassword("");
      setConfirm("");
      setDone(`已生成 ${name}。忘记密码将无法恢复，请把文件和密码分开保存。`);
    } catch (err) {
      setError(errorText(err, "生成备份失败。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={run} className="space-y-2.5 rounded-xl border border-line bg-card px-3.5 py-3">
      <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
        <Download className="size-4 text-ink-soft" /> 下载加密备份
      </p>
      <p className="text-[12px] leading-relaxed text-ink-soft">
        包含设备昵称、图标、颜色、芯片序列号绑定、私钥与种子、查询设置和历史报告，用你设置的密码在本机加密。
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-[12.5px]">
          <span className="font-medium">备份密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            aria-invalid={tooShort}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1 text-[12.5px]">
          <span className="font-medium">再次输入</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            aria-invalid={mismatch}
            className={inputClass}
          />
        </label>
      </div>
      <p className={cn("text-xs", tooShort || mismatch ? "text-danger" : "text-ink-faint")}>
        {tooShort ? `密码至少 ${MIN_PASSWORD} 个字符。` : mismatch ? "两次输入的密码不一致。" : `至少 ${MIN_PASSWORD} 个字符。密码不会被保存。`}
      </p>
      <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink">
        <input
          type="checkbox"
          checked={includeAccount}
          onChange={(e) => setIncludeAccount(e.target.checked)}
          disabled={busy}
          className="mt-0.5 size-4 accent-[var(--persimmon)]"
        />
        <span>
          同时备份 Apple 登录会话
          <span className="block text-ink-faint">默认不包含。会话可代表你的 Apple 账号查询报告，只在确有需要时加入；密码和验证码从不保存，也不会进入备份。</span>
        </span>
      </label>
      <Button type="submit" size="sm" disabled={!canExport}>
        {busy ? <Loader2 className="animate-spin" /> : <Download />} 下载备份
      </Button>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {done && <InlineNotice tone="ok">{done}</InlineNotice>}
    </form>
  );
}

function BackupRestore({ session }: { session: DataSession }) {
  const fileInput = useRef<HTMLInputElement>(null);
  // The encrypted text stays in component memory only until restore finishes or is cancelled.
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"read" | "preview" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setPassword("");
    setPreview(null);
    setConfirmed(false);
    if (fileInput.current) fileInput.current.value = "";
  };

  const onFile = async (picked: File | undefined) => {
    setError(null);
    setDone(null);
    setPreview(null);
    setConfirmed(false);
    if (!picked) return;
    setBusy("read");
    try {
      setFile({ name: picked.name, text: await readTextFile(picked) });
    } catch (err) {
      setFile(null);
      setError(errorText(err, "读取文件失败。"));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const runPreview = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || !password) return;
    setBusy("preview");
    setError(null);
    setPreview(null);
    setConfirmed(false);
    try {
      setPreview(await session.previewBackup(file.text, password));
    } catch (err) {
      setError(`${errorText(err, "无法解密备份。")} 当前数据没有改变。`);
    } finally {
      setBusy(null);
    }
  };

  const runRestore = async () => {
    if (!file || !preview || !confirmed) return;
    setBusy("restore");
    setError(null);
    try {
      const result = await session.restoreBackup(file.text, password);
      reset();
      setDone(`已合并 ${result.deviceCount} 台设备、${result.reportCount} 条报告。`);
    } catch (err) {
      setError(`${errorText(err, "恢复失败。")} 当前数据没有改变。`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-card px-3.5 py-3">
      <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink">
        <Upload className="size-4 text-ink-soft" /> 从备份恢复
      </p>
      <p className="text-[12px] leading-relaxed text-ink-soft">
        合并到现有数据，不会删除或覆盖此浏览器中已有的设备。密码错误、文件被改动或与现有密钥 / 序列号冲突时整体拒绝，当前数据保持不变。
      </p>
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={!!busy || !session.workspaceReady}>
          {busy === "read" ? <Loader2 className="animate-spin" /> : <FileUp />} 选择备份文件
        </Button>
        {file && <span className="min-w-0 truncate text-[12.5px] text-ink-soft">{file.name}</span>}
      </div>

      {file && (
        <form onSubmit={runPreview} className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1 text-[12.5px]">
            <span className="font-medium">备份密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPreview(null);
                setConfirmed(false);
              }}
              autoComplete="current-password"
              disabled={!!busy}
              className={inputClass}
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={!password || !!busy}>
            {busy === "preview" && <Loader2 className="animate-spin" />} 解密预览
          </Button>
        </form>
      )}

      {preview && (
        <div className="space-y-2 rounded-lg border border-line bg-paper px-3 py-2.5 text-[12.5px]">
          <p className="text-ink">
            备份创建于 {absoluteTime(preview.createdAt)}：{preview.deviceCount} 台设备、{preview.reportCount} 条报告
            {preview.hasAccount ? "，含 Apple 登录会话" : ""}。
          </p>
          <label className="flex cursor-pointer items-start gap-2 text-ink">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={!!busy}
              className="mt-0.5 size-4 accent-[var(--persimmon)]"
            />
            我确认把这些数据合并到此浏览器。
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void runRestore()} disabled={!confirmed || !!busy}>
              {busy === "restore" && <Loader2 className="animate-spin" />} 合并恢复
            </Button>
            <Button size="sm" variant="ghost" onClick={reset} disabled={!!busy}>
              取消
            </Button>
          </div>
        </div>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {done && <InlineNotice tone="ok">{done}</InlineNotice>}
    </div>
  );
}
