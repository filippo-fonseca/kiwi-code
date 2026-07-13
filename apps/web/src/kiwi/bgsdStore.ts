/**
 * kiwi-ui: the single Zustand store the whole Kiwi surface reads from.
 *
 * It owns the latest {@link BgsdWorkspaceSnapshot} and a rolling, seq-ordered,
 * deduped event log. Reducers fold snapshots and event batches; derived
 * selectors expose the shapes the components want. The store consumes ONLY a
 * {@link BgsdFeed}; `connectBgsdFeed` is the one wiring point for a real push
 * source.
 */
import type {
  BgsdAgent,
  BgsdOutboxEvent,
  BgsdPush,
  BgsdStage,
  BgsdTokensSummary,
  BgsdWorkspaceSnapshot,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { BgsdFeed } from "./feed";

/** Cap on the retained event log. Oldest entries are dropped past this. */
export const EVENT_LOG_CAP = 2000;

export const KIWI_STAGE_ORDER: readonly BgsdStage[] = [
  "conductor",
  "loop1",
  "merge",
  "loop2",
  "review",
  "done",
];

export type AgentStatusBucket = "running" | "needs_input" | "blocked" | "done" | "failed";

interface BgsdStoreState {
  /** Latest full projection, or null before the first snapshot. */
  snapshot: BgsdWorkspaceSnapshot | null;
  /** Rolling event log, ascending by seq, capped and deduped. */
  events: BgsdOutboxEvent[];
  /** Highest seq we have folded, so late/duplicate batches are ignored. */
  lastSeq: number;
  /** UI: request to reveal the token section of the dashboard. */
  tokenFocusRequestId: number;
  /** UI: request to open/activate the Kiwi surface on the active thread. */
  openSurfaceRequestId: number;

  applySnapshot: (snapshot: BgsdWorkspaceSnapshot) => void;
  applyEvents: (events: readonly BgsdOutboxEvent[]) => void;
  applyPush: (push: BgsdPush) => void;
  markUnavailable: (reason?: string) => void;
  requestTokenFocus: () => void;
  requestOpenSurface: () => void;
  reset: () => void;
}

/** Merge a fresh event batch into the ordered, deduped, capped log. */
function mergeEvents(
  current: readonly BgsdOutboxEvent[],
  incoming: readonly BgsdOutboxEvent[],
): BgsdOutboxEvent[] {
  if (incoming.length === 0) return current as BgsdOutboxEvent[];
  const bySeq = new Map<number, BgsdOutboxEvent>();
  for (const event of current) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return merged.length > EVENT_LOG_CAP ? merged.slice(merged.length - EVENT_LOG_CAP) : merged;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Fold a single event's `meta` into the live snapshot so the dashboard stays
 * current between full snapshots. Only well-known types mutate state; unknown
 * types are inert here (they still land in the event log for the timeline).
 */
function foldEventIntoSnapshot(
  snapshot: BgsdWorkspaceSnapshot,
  event: BgsdOutboxEvent,
): BgsdWorkspaceSnapshot {
  const meta = asRecord(event.meta);
  switch (event.type) {
    case "run-state":
    case "stage": {
      const nextState = typeof meta?.state === "string" ? meta.state : snapshot.state;
      const nextStage = typeof meta?.stage === "string" ? meta.stage : snapshot.stage;
      if (nextState === snapshot.state && nextStage === snapshot.stage) return snapshot;
      return { ...snapshot, state: nextState ?? null, stage: nextStage ?? null };
    }
    case "tokens": {
      if (!meta) return snapshot;
      const prev = snapshot.tokens ?? {};
      const prevTotals = prev.totals ?? {};
      const totals: BgsdTokensSummary["totals"] = {
        ...prevTotals,
        ...(typeof meta.calls === "number" ? { calls: meta.calls } : {}),
        ...(typeof meta.input === "number" ? { input: meta.input } : {}),
        ...(typeof meta.output === "number" ? { output: meta.output } : {}),
        ...(typeof meta.cost === "number" ? { cost: meta.cost, costKnown: true } : {}),
      };
      return { ...snapshot, tokens: { ...prev, totals } };
    }
    case "agent-phase":
    case "agent-spawned":
    case "agent-escalation":
    case "agent-done": {
      const agentId = typeof meta?.agent_id === "string" ? meta.agent_id : null;
      if (!agentId) return snapshot;
      const agents = snapshot.agents ? [...snapshot.agents] : [];
      const index = agents.findIndex((agent) => agent.agent_id === agentId);
      const phase = typeof meta?.phase === "string" ? meta.phase : undefined;
      const status =
        event.type === "agent-done"
          ? "done"
          : event.type === "agent-escalation"
            ? "needs_input"
            : phase === "done"
              ? "done"
              : phase === "failed"
                ? "failed"
                : phase === "blocked"
                  ? "blocked"
                  : "running";
      if (index >= 0) {
        const existing = agents[index]!;
        agents[index] = {
          ...existing,
          ...(phase ? { phase } : {}),
          status,
          heartbeat: "alive",
          heartbeat_at: event.at ?? existing.heartbeat_at,
        };
      } else if (event.type === "agent-spawned") {
        agents.push({
          agent_id: agentId,
          unit_id: typeof meta?.unit_id === "string" ? meta.unit_id : null,
          phase: phase ?? "plan",
          status: "running",
          heartbeat: "alive",
          heartbeat_at: event.at,
        });
      }
      return { ...snapshot, agents };
    }
    default:
      return snapshot;
  }
}

export const useBgsdStore = create<BgsdStoreState>()((set) => ({
  snapshot: null,
  events: [],
  lastSeq: 0,
  tokenFocusRequestId: 0,
  openSurfaceRequestId: 0,

  applySnapshot: (snapshot) => set(() => ({ snapshot })),

  applyEvents: (incoming) =>
    set((state) => {
      // Ignore already-folded seqs so replays/duplicates are idempotent.
      const fresh = incoming.filter((event) => event.seq > state.lastSeq);
      const events = mergeEvents(state.events, incoming);
      let snapshot = state.snapshot;
      if (snapshot) {
        for (const event of fresh) snapshot = foldEventIntoSnapshot(snapshot, event);
      }
      const highestSeq = incoming.reduce((max, event) => Math.max(max, event.seq), state.lastSeq);
      return { events, snapshot, lastSeq: highestSeq };
    }),

  applyPush: (push) =>
    set((state) => {
      switch (push.kind) {
        case "bgsd_snapshot":
          return { snapshot: push.snapshot };
        case "bgsd_events": {
          const fresh = push.events.filter((event) => event.seq > state.lastSeq);
          const events = mergeEvents(state.events, push.events);
          let snapshot = state.snapshot;
          if (snapshot) {
            for (const event of fresh) snapshot = foldEventIntoSnapshot(snapshot, event);
          }
          const highestSeq = push.events.reduce(
            (max, event) => Math.max(max, event.seq),
            state.lastSeq,
          );
          return { events, snapshot, lastSeq: highestSeq };
        }
        case "bgsd_unavailable":
          return {
            snapshot: state.snapshot
              ? { ...state.snapshot, available: false }
              : { workspaceRoot: push.workspaceRoot, available: false },
          };
        default:
          return state;
      }
    }),

  markUnavailable: () =>
    set((state) => ({
      snapshot: state.snapshot ? { ...state.snapshot, available: false } : state.snapshot,
    })),

  requestTokenFocus: () => set((state) => ({ tokenFocusRequestId: state.tokenFocusRequestId + 1 })),

  requestOpenSurface: () =>
    set((state) => ({ openSurfaceRequestId: state.openSurfaceRequestId + 1 })),

  reset: () => set(() => ({ snapshot: null, events: [], lastSeq: 0, openSurfaceRequestId: 0 })),
}));

/**
 * THE single wiring point for a real push source. Subscribes the store to a
 * {@link BgsdFeed} and returns a disconnect function. The real server feed
 * (owned by a parallel unit) implements the same interface, so swapping the
 * fixture for production is a one-line change at the call site.
 */
export function connectBgsdFeed(feed: BgsdFeed): () => void {
  const { applyPush } = useBgsdStore.getState();
  return feed.subscribe(applyPush);
}

// --- Derived selectors (pure; take a snapshot/state, return view shapes) ---

export function selectCurrentStage(snapshot: BgsdWorkspaceSnapshot | null): BgsdStage | null {
  const stage = snapshot?.stage;
  return stage && (KIWI_STAGE_ORDER as readonly string[]).includes(stage)
    ? (stage as BgsdStage)
    : null;
}

/** Bucket an agent by its status/phase into a UI status pill. */
export function bucketForAgent(agent: BgsdAgent): AgentStatusBucket {
  const status = (agent.status ?? "").toLowerCase();
  const phase = (agent.phase ?? "").toLowerCase();
  if (status.includes("fail") || phase === "failed") return "failed";
  if (status.includes("block") || phase === "blocked") return "blocked";
  if (status.includes("input") || status.includes("escalat") || status.includes("needs")) {
    return "needs_input";
  }
  if (status === "done" || phase === "done") return "done";
  return "running";
}

export function selectAgentsByStatus(
  snapshot: BgsdWorkspaceSnapshot | null,
): Record<AgentStatusBucket, BgsdAgent[]> {
  const buckets: Record<AgentStatusBucket, BgsdAgent[]> = {
    running: [],
    needs_input: [],
    blocked: [],
    done: [],
    failed: [],
  };
  for (const agent of snapshot?.agents ?? []) buckets[bucketForAgent(agent)].push(agent);
  return buckets;
}

export interface KiwiTotals {
  agentCount: number;
  running: number;
  input: number;
  output: number;
  cost: number | null;
  costKnown: boolean;
}

export function selectTotals(snapshot: BgsdWorkspaceSnapshot | null): KiwiTotals {
  const agents = snapshot?.agents ?? [];
  const totals = snapshot?.tokens?.totals ?? {};
  return {
    agentCount: agents.length,
    running: agents.filter((agent) => bucketForAgent(agent) === "running").length,
    input: totals.input ?? 0,
    output: totals.output ?? 0,
    cost: totals.cost ?? null,
    costKnown: totals.costKnown ?? totals.cost != null,
  };
}
