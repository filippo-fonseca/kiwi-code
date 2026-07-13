/**
 * kiwi-ui: shared, kiwi-owned presentation helpers.
 *
 * The kiwi-green accent lives here (as Tailwind arbitrary values so no global
 * theme tokens are touched) and is used sparingly: the active pipeline stage,
 * running status pills, and Kiwi's avatar. Everything else defers to the app's
 * existing semantic background/text/border classes for dark/light parity.
 */
import type { AgentStatusBucket } from "./bgsdStore";

/** Kiwi green, as an arbitrary color usable in text/bg/border/ring utilities. */
export const KIWI_GREEN = "#7cb342";

export const KIWI_ACCENT_TEXT = "text-[#7cb342]";
export const KIWI_ACCENT_BG = "bg-[#7cb342]";
export const KIWI_ACCENT_RING = "ring-[#7cb342]";

/** Human-facing labels for the run stages, in pipeline order. */
export const STAGE_LABELS: Record<string, string> = {
  conductor: "Conductor",
  loop1: "Loop 1",
  merge: "Merge",
  loop2: "Loop 2",
  review: "Review Gate",
  done: "Done",
};

export const STATUS_PILL_LABELS: Record<AgentStatusBucket, string> = {
  running: "running",
  needs_input: "needs input",
  blocked: "blocked",
  done: "done",
  failed: "failed",
};

/** Tailwind classes for each status pill (semantic tokens + kiwi accent). */
export function statusPillClasses(bucket: AgentStatusBucket): string {
  switch (bucket) {
    case "running":
      return "bg-[#7cb342]/15 text-[#5b8c2f] ring-1 ring-inset ring-[#7cb342]/30 dark:text-[#a5d66b]";
    case "needs_input":
      return "bg-amber-500/15 text-amber-700 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300";
    case "blocked":
      return "bg-orange-500/15 text-orange-700 ring-1 ring-inset ring-orange-500/30 dark:text-orange-300";
    case "failed":
      return "bg-destructive/15 text-destructive ring-1 ring-inset ring-destructive/30";
    case "done":
      return "bg-muted text-muted-foreground ring-1 ring-inset ring-border";
  }
}

/** Heartbeat freshness dot color. */
export function heartbeatDotClasses(heartbeat: string | undefined): string {
  switch (heartbeat) {
    case "alive":
      return "bg-[#7cb342]";
    case "stale":
      return "bg-amber-500";
    case "dead":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

/** Compact relative time, e.g. "4s", "12m", "3h", "2d". Null-safe. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Compact number formatting for token counts, e.g. 812400 -> "812.4k". */
export function compactNumber(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** Format a USD cost, or an em-free placeholder when unknown. */
export function formatCost(cost: number | null | undefined, known: boolean): string {
  if (!known || cost == null) return "cost n/a";
  return `$${cost.toFixed(2)}`;
}
