"use client";

import { Backpack, Bike, BriefcaseBusiness, KeyRound, Tag, type LucideIcon } from "lucide-react";
import type { TagIcon } from "@/lib/contracts";
import { cn } from "@/lib/utils";

export const TAG_ICON_OPTIONS: { value: TagIcon; label: string; Icon: LucideIcon }[] = [
  { value: "keys", label: "钥匙", Icon: KeyRound },
  { value: "backpack", label: "背包", Icon: Backpack },
  { value: "luggage", label: "行李", Icon: BriefcaseBusiness },
  { value: "bike", label: "自行车", Icon: Bike },
  { value: "tag", label: "通用", Icon: Tag },
];

export const TAG_COLORS = ["#e8590c", "#2f6f5e", "#3b5bdb", "#9c36b5", "#c2255c", "#5c5f66"];

export function iconFor(icon: TagIcon): LucideIcon {
  return TAG_ICON_OPTIONS.find((option) => option.value === icon)?.Icon ?? Tag;
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-8", className)}>
      <rect width="32" height="32" rx="9" fill="var(--persimmon)" />
      <circle cx="16" cy="17" r="7.5" fill="none" stroke="#fffdf9" strokeWidth="3" />
      <circle cx="16" cy="17" r="2.6" fill="#fffdf9" />
      <circle cx="24.5" cy="7.5" r="2" fill="var(--ink)" />
    </svg>
  );
}

export function DeviceGlyph({
  icon,
  color,
  size = "md",
  muted = false,
}: {
  icon: TagIcon;
  color: string;
  size?: "sm" | "md" | "lg";
  muted?: boolean;
}) {
  const Icon = iconFor(icon);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-[10px] text-white",
        size === "sm" && "size-7 [&_svg]:size-3.5",
        size === "md" && "size-9 [&_svg]:size-[18px]",
        size === "lg" && "size-11 rounded-xl [&_svg]:size-5",
      )}
      style={{ background: muted ? "var(--ink-faint)" : color }}
    >
      <Icon strokeWidth={2.2} />
    </span>
  );
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-ink-soft",
  ok: "bg-ok-wash text-ok",
  warn: "bg-warn-wash text-warn",
  danger: "bg-danger-wash text-danger",
  accent: "bg-persimmon-wash text-persimmon-ink",
};

export function Chip({
  tone = "neutral",
  children,
  className,
  dot = false,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
