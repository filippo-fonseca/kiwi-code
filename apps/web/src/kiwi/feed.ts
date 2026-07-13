/**
 * kiwi-ui: the data seam between the Kiwi UI and its push source.
 *
 * ALL Kiwi UI consumes bgsd state exclusively through {@link BgsdFeed}. The
 * real server push source (a WebSocket/RPC bridge, owned by a parallel unit)
 * plugs in later behind the same tiny interface via `connectBgsdFeed` in
 * `./bgsdStore.ts`; nothing else in the UI needs to change.
 *
 * {@link FixtureBgsdFeed} replays a realistic scripted session on timers so the
 * whole surface can be developed and demoed with no server. It is gated behind
 * a dev flag (`localStorage["kiwi.fixture"] === "1"` or
 * `import.meta.env.VITE_KIWI_FIXTURE`).
 */
import type { BgsdPush, BgsdWorkspaceSnapshot } from "@t3tools/contracts";

/** The single contract every Kiwi data source implements. */
export type BgsdFeed = {
  /**
   * Subscribe to the push stream. The handler is invoked for every push
   * (snapshot, event batch, or unavailable). Returns an unsubscribe function
   * that MUST stop all further delivery and release any timers/sockets.
   */
  subscribe(handler: (push: BgsdPush) => void): () => void;
};

/** Dev flag: is the scripted fixture feed enabled? */
export function isFixtureFeedEnabled(): boolean {
  try {
    if (typeof localStorage !== "undefined" && localStorage.getItem("kiwi.fixture") === "1") {
      return true;
    }
  } catch {
    // localStorage can throw in locked-down contexts; ignore.
  }
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  return env?.VITE_KIWI_FIXTURE === "1" || env?.VITE_KIWI_FIXTURE === true;
}

const FIXTURE_ROOT = "/Users/kiwi/dev/hyperpolymath";
const FIXTURE_RUN = "run-2026-07-13-hp42";

function iso(offsetSeconds = 0): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

/** The opening snapshot: a decomposed run just entering execution. */
function fixtureSnapshot(): BgsdWorkspaceSnapshot {
  return {
    workspaceRoot: FIXTURE_ROOT,
    available: true,
    source: "fs",
    run_id: FIXTURE_RUN,
    state: "executing",
    stage: "loop1",
    health: {
      ok: true,
      protocol: 2,
      bgsd_version: "0.9.0",
      run_id: FIXTURE_RUN,
      conductor: { name: "Kiwi", emoji: "🥝" },
      capabilities: { events: true, tokens: true, queue: true, control: true },
    },
    sessions: {
      latest_run_id: FIXTURE_RUN,
      sessions: [
        {
          run_id: FIXTURE_RUN,
          title: "Build the Hyperpolymath command deck",
          scale: "project",
          state: "executing",
          stage: "loop1",
          status: "running",
          updated_at: iso(-4),
        },
        {
          run_id: "run-2026-07-12-hp41",
          title: "Wire the remote bridge auth",
          scale: "standard",
          state: "done",
          stage: "done",
          status: "done",
          updated_at: iso(-86_400),
        },
      ],
    },
    plan: {
      run_id: FIXTURE_RUN,
      scale: "project",
      state: "executing",
      stage: "loop1",
      waves: [{ wave: 1, units: ["unit-a", "unit-b", "unit-c"], started_at: iso(-120) }],
      units: [
        { id: "unit-a", title: "Contracts + schemas", difficulty: 0.3, status: "done" },
        { id: "unit-b", title: "Server push module", difficulty: 0.6, status: "running" },
        { id: "unit-c", title: "Kiwi UI layer", difficulty: 0.8, status: "running" },
      ],
    },
    agents: [
      {
        agent_id: "agent-a",
        unit_id: "unit-a",
        run_id: FIXTURE_RUN,
        phase: "done",
        status: "done",
        harness: "claude-code",
        model: "sonnet",
        model_assignment: {
          tier: "sonnet",
          source: "difficulty",
          reason: "trivial schema work (<0.2)",
        },
        worktree: `${FIXTURE_ROOT}-wt-contracts`,
        branch: "feat/contracts",
        heartbeat: "alive",
        heartbeat_at: iso(-8),
        progress: { iteration: 2, max_iterations: 2 },
      },
      {
        agent_id: "agent-b",
        unit_id: "unit-b",
        run_id: FIXTURE_RUN,
        phase: "execute",
        status: "running",
        harness: "claude-code",
        model: "opus",
        model_assignment: {
          tier: "opus",
          source: "difficulty",
          reason: "server protocol, moderate risk",
        },
        worktree: `${FIXTURE_ROOT}-wt-server`,
        branch: "feat/server",
        heartbeat: "alive",
        heartbeat_at: iso(-3),
        progress: { iteration: 1, max_iterations: 4 },
      },
      {
        agent_id: "agent-c",
        unit_id: "unit-c",
        run_id: FIXTURE_RUN,
        phase: "plan",
        status: "running",
        harness: "claude-code",
        model: "opus",
        model_assignment: {
          tier: "opus",
          source: "difficulty",
          reason: "wide UI surface, high difficulty (0.8)",
        },
        worktree: `${FIXTURE_ROOT}-wt-ui`,
        branch: "feat/ui",
        heartbeat: "alive",
        heartbeat_at: iso(-2),
        progress: { iteration: 1, max_iterations: 3 },
      },
    ],
    tokens: {
      run_id: FIXTURE_RUN,
      totals: { calls: 41, input: 812_400, output: 96_200, cost: 12.84, costKnown: true },
      byAgent: {
        "agent-a": { input: 120_000, output: 14_000, cost: 1.9 },
        "agent-b": { input: 402_000, output: 48_200, cost: 6.4 },
        "agent-c": { input: 290_400, output: 34_000, cost: 4.54 },
      },
    },
    queue: { counts: { queued: 2 }, items: [] },
    pending_questions: [],
  };
}

type ScriptedStep = { delayMs: number; push: BgsdPush };

/**
 * Build the timed script: after the snapshot, agents progress through phases,
 * Kiwi narrates, the run state advances, and tokens tick up. `seq` is strictly
 * increasing so the store can dedupe/order.
 */
function fixtureScript(): ScriptedStep[] {
  let seq = 0;
  const ev = (type: string, text?: string, meta?: unknown): BgsdPush => ({
    kind: "bgsd_events",
    workspaceRoot: FIXTURE_ROOT,
    run_id: FIXTURE_RUN,
    events: [{ seq: ++seq, at: iso(), type, ...(text ? { text } : {}), ...(meta ? { meta } : {}) }],
  });

  return [
    {
      delayMs: 900,
      push: ev(
        "narration",
        "Right then — three units in flight for wave 1. Keeping an eye on the server module.",
      ),
    },
    {
      delayMs: 1400,
      push: ev("agent-phase", "unit-c moved to UI design", { agent_id: "agent-c", phase: "ui" }),
    },
    {
      delayMs: 1200,
      push: ev(
        "narration",
        "unit-c is sketching the UI contract before it touches code. Sensible.",
      ),
    },
    {
      delayMs: 1600,
      push: ev("agent-phase", "unit-b entered verify", { agent_id: "agent-b", phase: "verify" }),
    },
    {
      delayMs: 1500,
      push: {
        kind: "bgsd_events",
        workspaceRoot: FIXTURE_ROOT,
        run_id: FIXTURE_RUN,
        events: [
          {
            seq: ++seq,
            at: iso(),
            type: "tokens",
            meta: { input: 902_100, output: 108_400, cost: 14.2 },
          },
        ],
      },
    },
    {
      delayMs: 1300,
      push: ev("agent-phase", "unit-c moved to plan", { agent_id: "agent-c", phase: "plan" }),
    },
    {
      delayMs: 1700,
      push: ev("agent-spawned", "Spawned agent-d for unit-d (docs pass)", {
        agent_id: "agent-d",
        unit_id: "unit-d",
      }),
    },
    {
      delayMs: 1200,
      push: ev("verification", "unit-b passed verification (0 defects)", { agent_id: "agent-b" }),
    },
    {
      delayMs: 1400,
      push: ev("agent-phase", "unit-b done", { agent_id: "agent-b", phase: "done" }),
    },
    {
      delayMs: 1500,
      push: ev("run-state", "Wave 1 verified — moving to merge", {
        state: "merging",
        stage: "merge",
      }),
    },
    {
      delayMs: 1300,
      push: ev("unit-merged", "Merged feat/server into next", { agent_id: "agent-b" }),
    },
    {
      delayMs: 1600,
      push: ev(
        "narration",
        "Server module is in. unit-c is executing now; I'll narrate as it goes.",
      ),
    },
    {
      delayMs: 1400,
      push: ev("agent-phase", "unit-c executing", { agent_id: "agent-c", phase: "execute" }),
    },
    {
      delayMs: 1800,
      push: ev("stage", "Entering Loop 2 (integration review)", {
        stage: "loop2",
        state: "integrating",
      }),
    },
    {
      delayMs: 1500,
      push: ev(
        "kiwi-easter-egg",
        "This is an unknown event type — the UI should render it as plain narration.",
      ),
    },
    {
      delayMs: 1600,
      push: ev("run-state", "Review gate reached — awaiting sign-off", {
        state: "review",
        stage: "review",
      }),
    },
  ];
}

/**
 * A scripted, timer-driven {@link BgsdFeed}. Emits the snapshot immediately on
 * subscribe, then walks the script. All timers are cleared on unsubscribe.
 */
export class FixtureBgsdFeed implements BgsdFeed {
  subscribe(handler: (push: BgsdPush) => void): () => void {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Snapshot first, on a microtask so subscribe() returns before delivery.
    const kickoff = setTimeout(() => {
      if (cancelled) return;
      handler({ kind: "bgsd_snapshot", snapshot: fixtureSnapshot() });

      let elapsed = 0;
      for (const step of fixtureScript()) {
        elapsed += step.delayMs;
        const timer = setTimeout(() => {
          if (cancelled) return;
          handler(step.push);
        }, elapsed);
        timers.push(timer);
      }
    }, 0);
    timers.push(kickoff);

    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    };
  }
}
