/**
 * kiwi-ui: the session timeline. Renders the rolling event log:
 *  - narration        -> chat-ish line from Kiwi (🥝 avatar)
 *  - stage / run-state -> centered divider banner
 *  - agent-* / others  -> compact system row
 *  - unknown types     -> plain narration (tolerated, never dropped)
 * Auto-scrolls with stick-to-bottom and pauses when the user scrolls up.
 * Read-only in this phase (no input box yet).
 */
import type { BgsdOutboxEvent } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { relativeTime } from "./kiwiTheme";

type Rendered = "narration" | "banner" | "system";

function classify(event: BgsdOutboxEvent): Rendered {
  switch (event.type) {
    case "stage":
    case "run-state":
    case "banner":
    case "wave-started":
    case "wave-done":
      return "banner";
    case "narration":
    case "note":
    case "message-in":
      return "narration";
    default:
      // agent-*, verification, unit-merged, tokens, pr-*, issue-linked, and any
      // unknown type render as a compact system row (unknown -> plain text).
      return event.type.startsWith("agent-") ||
        event.type === "verification" ||
        event.type === "unit-merged" ||
        event.type === "tokens" ||
        event.type.startsWith("pr-") ||
        event.type === "issue-linked" ||
        event.type === "branch-created"
        ? "system"
        : "narration";
  }
}

function fallbackText(event: BgsdOutboxEvent): string {
  if (event.text) return event.text;
  const meta =
    event.meta && typeof event.meta === "object" ? (event.meta as Record<string, unknown>) : null;
  const stage = typeof meta?.stage === "string" ? meta.stage : null;
  const state = typeof meta?.state === "string" ? meta.state : null;
  if (stage || state) return [state, stage].filter(Boolean).join(" · ");
  return event.type;
}

function NarrationLine({ event }: { event: BgsdOutboxEvent }) {
  return (
    <div className="flex items-start gap-2 py-1">
      <span
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[#7cb342]/15 text-xs"
        aria-hidden
      >
        🥝
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-foreground">{fallbackText(event)}</p>
        {event.at ? (
          <span className="text-[10px] text-muted-foreground/70">{relativeTime(event.at)} ago</span>
        ) : null}
      </div>
    </div>
  );
}

function BannerLine({ event }: { event: BgsdOutboxEvent }) {
  return (
    <div className="flex items-center gap-2 py-2" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        {fallbackText(event)}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function SystemLine({ event }: { event: BgsdOutboxEvent }) {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-7 text-xs text-muted-foreground">
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">{event.type}</span>
      <span className="min-w-0 flex-1 truncate">{fallbackText(event)}</span>
    </div>
  );
}

export function KiwiTimeline({ events }: { events: readonly BgsdOutboxEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom < 24);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }, [events, stickToBottom]);

  // Re-stick when the user returns to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }, [stickToBottom]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-kiwi-timeline>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {events.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            No activity yet. Kiwi will narrate here as the session runs.
          </p>
        ) : (
          events.map((event) => {
            const kind = classify(event);
            if (kind === "banner") return <BannerLine key={event.seq} event={event} />;
            if (kind === "system") return <SystemLine key={event.seq} event={event} />;
            return <NarrationLine key={event.seq} event={event} />;
          })
        )}
      </div>
      {!stickToBottom ? (
        <button
          type="button"
          onClick={() => setStickToBottom(true)}
          className={cn(
            "absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm hover:text-foreground",
          )}
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
