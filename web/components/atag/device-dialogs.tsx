"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { DeviceMetadataPatch, TagDevice, TagIcon } from "@/lib/contracts";
import { toClientError } from "@/lib/client-support";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DeviceGlyph, TAG_COLORS, TAG_ICON_OPTIONS } from "./primitives";

export function EditDeviceDialog({
  device,
  open,
  onOpenChange,
  onSave,
}: {
  device: TagDevice | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(patch: DeviceMetadataPatch): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<TagIcon>("tag");
  const [color, setColor] = useState(TAG_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && device) {
      setName(device.name);
      setIcon(device.icon);
      setColor(device.color);
      setError(null);
      setSaving(false);
    }
  }, [open, device]);

  if (!device) return null;
  const trimmed = name.trim();
  const invalid = trimmed.length === 0 || trimmed.length > 32;
  const unchanged = trimmed === device.name && icon === device.icon && color === device.color;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid || unchanged) return;
    setSaving(true);
    setError(null);
    try {
      const patch: DeviceMetadataPatch = {};
      if (trimmed !== device.name) patch.name = trimmed;
      if (icon !== device.icon) patch.icon = icon;
      if (color !== device.color) patch.color = color;
      await onSave(patch);
      onOpenChange(false);
    } catch (err) {
      setError(toClientError(err).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent showCloseButton={false} className="rounded-2xl bg-card sm:max-w-md">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>编辑设备</DialogTitle>
            <DialogDescription>只修改档案里的名称、图标和颜色，不会改写 tag 中的配置。</DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-3 rounded-xl bg-muted/60 p-3">
            <DeviceGlyph icon={icon} color={color} size="lg" />
            <span className="truncate text-[15px] font-semibold">{trimmed || "未命名"}</span>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="device-name" className="text-sm font-medium">名称</label>
            <input
              id="device-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              autoComplete="off"
              aria-invalid={invalid}
              aria-describedby="device-name-hint"
              className="h-10 rounded-xl border border-input bg-background px-3 text-sm outline-none focus-visible:border-persimmon focus-visible:ring-2 focus-visible:ring-persimmon/25"
            />
            <p id="device-name-hint" className={cn("text-xs", invalid ? "text-danger" : "text-ink-faint")}>
              {invalid ? "名称需要 1–32 个字符" : `${trimmed.length}/32`}
            </p>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">图标</legend>
            <div className="grid grid-cols-5 gap-2">
              {TAG_ICON_OPTIONS.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setIcon(value)}
                  aria-pressed={icon === value}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-xl border py-2 text-[12px] transition-colors",
                    icon === value ? "border-ink bg-card text-ink" : "border-line text-ink-soft hover:border-input",
                  )}
                >
                  <Icon className="size-[18px]" />
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">颜色</legend>
            <div className="flex flex-wrap gap-2.5">
              {TAG_COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setColor(value)}
                  aria-label={`颜色 ${value}`}
                  aria-pressed={color === value}
                  className={cn(
                    "grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-card transition",
                    color === value && "ring-2 ring-ink",
                  )}
                  style={{ background: value }}
                >
                  {color === value && <Check className="size-4 text-white" />}
                </button>
              ))}
            </div>
          </fieldset>

          {error && <p role="alert" className="rounded-lg bg-danger-wash px-3 py-2 text-sm text-danger">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              取消
            </Button>
            <Button type="submit" disabled={invalid || unchanged || saving}>
              {saving && <Loader2 className="animate-spin" />}
              {saving ? "保存中" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDeviceDialog({
  device,
  open,
  onOpenChange,
  onConfirm,
}: {
  device: TagDevice | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  if (!device) return null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(toClientError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent className="rounded-2xl bg-card">
        <AlertDialogHeader>
          <AlertDialogTitle>删除“{device.name}”的档案？</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-ink-soft">
              <p>从此浏览器删除这个设备档案、私钥、查询设置和已保存的报告。</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>不会擦除或重置物理 tag，它会继续按原配置广播。</li>
                <li>删除后将无法再下载或解密这个 Tag 的报告；如需保留，请先下载加密备份。</li>
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="rounded-lg bg-danger-wash px-3 py-2 text-sm text-danger">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            删除档案
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
