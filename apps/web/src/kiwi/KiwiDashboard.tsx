/**
 * kiwi-ui: the Kiwi dashboard surface, rendered inside the right panel.
 *
 * Composes the pipeline rail, agent grid, session config, and token meter, with
 * a collapsible timeline. On mount (when the fixture dev-flag is set and nothing
 * has connected yet) it wires the FixtureBgsdFeed so the surface is demoable
 * with no server; the real feed connects via `connectBgsdFeed` elsewhere.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import {
  connectBgsdFeed,
  selectAgentsByStatus,
  selectCurrentStage,
  useBgsdStore,
} from "./bgsdStore";
import { cn } from "~/lib/utils";
import { AgentGrid } from "./AgentGrid";
import { FixtureBgsdFeed, isFixtureFeedEnabled } from "./feed";
import { KiwiTimeline } from "./KiwiTimeline";
import { PipelineRail } from "./PipelineRail";
import { SeshConfigCard } from "./SeshConfigCard";
import { TokenMeter } from "./TokenMeter";

type Tab = "overview" | "timeline";

/**
 * Ensures the fixture feed is connected at most once per page load when the dev
 * flag is on and no snapshot has arrived. A module-level guard keeps repeated
 * mounts (surface re-open) from stacking duplicate feeds.
 */
let fixtureConnected = false;

function useMaybeFixtureFeed() {
  useEffect(() => {
    if (fixtureConnected) return;
    if (!isFixtureFeedEnabled()) return;
    if (useBgsdStore.getState().snapshot) return;
    fixtureConnected = true;
    const disconnect = connectBgsdFeed(new FixtureBgsdFeed());
    return () => {
      disconnect();
      fixtureConnected = false;
    };
  }, []);
}

export function KiwiDashboard() {
  useMaybeFixtureFeed();

  const snapshot = useBgsdStore((state) => state.snapshot);
  const events = useBgsdStore((state) => state.events);
  const tokenFocusRequestId = useBgsdStore((state) => state.tokenFocusRequestId);

  const [tab, setTab] = useState<Tab>("overview");
  const tokenMeterRef = useRef<HTMLDivElement>(null);

  const stage = useMemo(() => selectCurrentStage(snapshot), [snapshot]);
  const buckets = useMemo(() => selectAgentsByStatus(snapshot), [snapshot]);
  const orderedAgents = useMemo(
    () => [
      ...buckets.needs_input,
      ...buckets.blocked,
      ...buckets.running,
      ...buckets.failed,
      ...buckets.done,
    ],
    [buckets],
  );

  // Honor a request to reveal the token section (from the status bar).
  useEffect(() => {
    if (tokenFocusRequestId === 0) return;
    setTab("overview");
    // Defer to let the overview tab mount before scrolling.
    const id = requestAnimationFrame(() => {
      tokenMeterRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [tokenFocusRequestId]);

  if (!snapshot) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="text-center">
          <span className="text-3xl" aria-hidden>
            🥝
          </span>
          <p className="mt-2 text-sm font-medium text-foreground">No active Kiwi session</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Waiting for a bgsd run. Enable the fixture feed (localStorage
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">kiwi.fixture=1</code>) to
            preview.
          </p>
        </div>
      </div>
    );
  }

  const runTitle =
    snapshot.sessions?.sessions.find((s) => s.run_id === snapshot.run_id)?.title ??
    snapshot.run_id ??
    "bgsd session";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-kiwi-dashboard>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-base" aria-hidden>
            🥝
          </span>
          <span className="truncate text-sm font-semibold text-foreground">{runTitle}</span>
          {!snapshot.available ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              offline
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md bg-muted/60 p-0.5">
          {(["overview", "timeline"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                tab === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="border-b border-border/60 pb-2">
            <PipelineRail stage={stage} />
          </div>
          <div className="mt-3 flex flex-col gap-3">
            <SeshConfigCard snapshot={snapshot} />
            <TokenMeter ref={tokenMeterRef} tokens={snapshot.tokens} />
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Agents ({orderedAgents.length})
              </h4>
              <AgentGrid agents={orderedAgents} />
            </div>
          </div>
        </div>
      ) : (
        <KiwiTimeline events={events} />
      )}
    </div>
  );
}
