import type { BgsdOutboxEvent, BgsdWorkspaceSnapshot } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { FixtureBgsdFeed } from "./feed";
import {
  bucketForAgent,
  connectBgsdFeed,
  EVENT_LOG_CAP,
  selectAgentsByStatus,
  selectCurrentStage,
  selectTotals,
  useBgsdStore,
} from "./bgsdStore";

const baseSnapshot: BgsdWorkspaceSnapshot = {
  workspaceRoot: "/tmp/ws",
  available: true,
  source: "fs",
  run_id: "run-1",
  state: "executing",
  stage: "loop1",
  agents: [
    { agent_id: "a", unit_id: "u-a", phase: "execute", status: "running", heartbeat: "alive" },
    { agent_id: "b", unit_id: "u-b", phase: "done", status: "done", heartbeat: "alive" },
  ],
  tokens: { totals: { input: 1000, output: 200, cost: 3, costKnown: true } },
};

const evt = (seq: number, type: string, meta?: unknown, text?: string): BgsdOutboxEvent => ({
  seq,
  type,
  at: "2026-07-13T00:00:00.000Z",
  ...(text ? { text } : {}),
  ...(meta ? { meta } : {}),
});

beforeEach(() => {
  useBgsdStore.getState().reset();
});

describe("bgsdStore — snapshot merge", () => {
  it("stores the latest snapshot", () => {
    useBgsdStore.getState().applySnapshot(baseSnapshot);
    expect(useBgsdStore.getState().snapshot?.run_id).toBe("run-1");
  });

  it("replaces the snapshot wholesale on a new snapshot push", () => {
    useBgsdStore.getState().applyPush({ kind: "bgsd_snapshot", snapshot: baseSnapshot });
    useBgsdStore.getState().applyPush({
      kind: "bgsd_snapshot",
      snapshot: { ...baseSnapshot, run_id: "run-2", stage: "review" },
    });
    expect(useBgsdStore.getState().snapshot?.run_id).toBe("run-2");
    expect(useBgsdStore.getState().snapshot?.stage).toBe("review");
  });

  it("marks unavailable without dropping the snapshot shape", () => {
    useBgsdStore.getState().applySnapshot(baseSnapshot);
    useBgsdStore
      .getState()
      .applyPush({ kind: "bgsd_unavailable", workspaceRoot: "/tmp/ws", reason: "gone" });
    expect(useBgsdStore.getState().snapshot?.available).toBe(false);
    expect(useBgsdStore.getState().snapshot?.run_id).toBe("run-1");
  });
});

describe("bgsdStore — event log ordering & dedupe", () => {
  it("keeps events sorted ascending by seq", () => {
    useBgsdStore.getState().applyEvents([evt(3, "narration"), evt(1, "narration")]);
    useBgsdStore.getState().applyEvents([evt(2, "narration")]);
    expect(useBgsdStore.getState().events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("dedupes by seq, last write wins on payload", () => {
    useBgsdStore.getState().applyEvents([evt(1, "narration", undefined, "first")]);
    useBgsdStore.getState().applyEvents([evt(1, "narration", undefined, "second")]);
    const events = useBgsdStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("second");
  });

  it("ignores already-folded seqs when folding into the snapshot", () => {
    useBgsdStore.getState().applySnapshot(baseSnapshot);
    useBgsdStore.getState().applyEvents([evt(5, "run-state", { stage: "merge" })]);
    // A stale, lower seq must not re-fold and clobber the newer stage.
    useBgsdStore.getState().applyEvents([evt(2, "run-state", { stage: "loop1" })]);
    expect(useBgsdStore.getState().snapshot?.stage).toBe("merge");
  });

  it("caps the log at EVENT_LOG_CAP, dropping the oldest", () => {
    const batch = Array.from({ length: EVENT_LOG_CAP + 50 }, (_, i) => evt(i + 1, "narration"));
    useBgsdStore.getState().applyEvents(batch);
    const events = useBgsdStore.getState().events;
    expect(events).toHaveLength(EVENT_LOG_CAP);
    expect(events[0]?.seq).toBe(51);
    expect(events.at(-1)?.seq).toBe(EVENT_LOG_CAP + 50);
  });
});

describe("bgsdStore — event folding", () => {
  it("advances stage/state from run-state events", () => {
    useBgsdStore.getState().applySnapshot(baseSnapshot);
    useBgsdStore
      .getState()
      .applyEvents([evt(1, "run-state", { state: "merging", stage: "merge" })]);
    expect(useBgsdStore.getState().snapshot?.stage).toBe("merge");
    expect(useBgsdStore.getState().snapshot?.state).toBe("merging");
  });

  it("updates token totals from tokens events", () => {
    useBgsdStore.getState().applySnapshot(baseSnapshot);
    useBgsdStore.getState().applyEvents([evt(1, "tokens", { input: 5000, cost: 9.5 })]);
    const totals = useBgsdStore.getState().snapshot?.tokens?.totals;
    expect(totals?.input).toBe(5000);
    expect(totals?.output).toBe(200); // preserved from snapshot
    expect(totals?.cost).toBe(9.5);
  });

  it("updates an agent's phase/status from agent-phase events", () => {
    useBgsdStore.getState().applySnapshot(baseSnapshot);
    useBgsdStore
      .getState()
      .applyEvents([evt(1, "agent-phase", { agent_id: "a", phase: "verify" })]);
    const agent = useBgsdStore.getState().snapshot?.agents?.find((x) => x.agent_id === "a");
    expect(agent?.phase).toBe("verify");
    expect(agent?.status).toBe("running");
  });

  it("appends a new agent on agent-spawned", () => {
    useBgsdStore.getState().applySnapshot(baseSnapshot);
    useBgsdStore
      .getState()
      .applyEvents([evt(1, "agent-spawned", { agent_id: "c", unit_id: "u-c" })]);
    const agents = useBgsdStore.getState().snapshot?.agents ?? [];
    expect(agents.map((a) => a.agent_id)).toContain("c");
  });

  it("leaves the snapshot untouched for unknown event types", () => {
    useBgsdStore.getState().applySnapshot(baseSnapshot);
    const before = useBgsdStore.getState().snapshot;
    useBgsdStore.getState().applyEvents([evt(1, "kiwi-easter-egg", undefined, "hello")]);
    expect(useBgsdStore.getState().snapshot).toBe(before);
    // ...but the event still lands in the log for the timeline.
    expect(useBgsdStore.getState().events).toHaveLength(1);
  });
});

describe("bgsdStore — selectors", () => {
  it("selectCurrentStage returns a valid stage or null", () => {
    expect(selectCurrentStage(baseSnapshot)).toBe("loop1");
    expect(selectCurrentStage({ ...baseSnapshot, stage: "bogus" })).toBeNull();
    expect(selectCurrentStage(null)).toBeNull();
  });

  it("bucketForAgent classifies by status/phase", () => {
    expect(bucketForAgent({ agent_id: "x", status: "running" })).toBe("running");
    expect(bucketForAgent({ agent_id: "x", status: "done" })).toBe("done");
    expect(bucketForAgent({ agent_id: "x", phase: "blocked" })).toBe("blocked");
    expect(bucketForAgent({ agent_id: "x", phase: "failed" })).toBe("failed");
    expect(bucketForAgent({ agent_id: "x", status: "needs_input" })).toBe("needs_input");
  });

  it("selectAgentsByStatus groups agents", () => {
    const buckets = selectAgentsByStatus(baseSnapshot);
    expect(buckets.running.map((a) => a.agent_id)).toEqual(["a"]);
    expect(buckets.done.map((a) => a.agent_id)).toEqual(["b"]);
  });

  it("selectTotals aggregates counts and tokens", () => {
    const totals = selectTotals(baseSnapshot);
    expect(totals.agentCount).toBe(2);
    expect(totals.running).toBe(1);
    expect(totals.input).toBe(1000);
    expect(totals.output).toBe(200);
    expect(totals.cost).toBe(3);
    expect(totals.costKnown).toBe(true);
  });

  it("selectTotals is safe on a null snapshot", () => {
    const totals = selectTotals(null);
    expect(totals.agentCount).toBe(0);
    expect(totals.cost).toBeNull();
  });
});

describe("FixtureBgsdFeed + connectBgsdFeed", () => {
  it("delivers a snapshot and can be disconnected", async () => {
    const feed = new FixtureBgsdFeed();
    const disconnect = connectBgsdFeed(feed);
    // The snapshot is delivered on a 0ms timer; wait a tick.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(useBgsdStore.getState().snapshot?.available).toBe(true);
    expect(useBgsdStore.getState().snapshot?.agents?.length).toBeGreaterThan(0);
    disconnect();
  });

  it("subscribe returns an unsubscribe that halts delivery", async () => {
    const feed = new FixtureBgsdFeed();
    let count = 0;
    const unsub = feed.subscribe(() => {
      count += 1;
    });
    unsub();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count).toBe(0);
  });
});
