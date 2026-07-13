/**
 * bgsd projection — normalize either source into the frozen
 * `BgsdWorkspaceSnapshot` and derive incremental `BgsdPush` values.
 *
 * The service layer (service.ts) drives this: on subscribe it emits one
 * `bgsd_snapshot`, then deltas — `bgsd_events` for fresh outbox batches, and a
 * fresh `bgsd_snapshot` whenever a *structural* change is detected (run state,
 * stage, agent set, plan, tokens, queue, health). Idle polling that produces an
 * equal snapshot pushes nothing, gated by a cheap structural-equality check.
 *
 * Two projectors:
 *   - {@link projectFromBridge} talks to a live bridge, capability-gating the
 *     v2 routes and synthesizing agents/run from `/api/state` on a v1 bridge.
 *   - {@link projectFromFs} reads the on-disk `.bgsd/` tree.
 *
 * @module bgsd/projection
 */
import {
  BgsdAgent,
  type BgsdHealth,
  type BgsdOutboxEvent,
  type BgsdPlan,
  type BgsdPush,
  type BgsdQueue,
  type BgsdSessions,
  type BgsdTokensSummary,
  type BgsdWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import { hasCapability, type BgsdBridgeClient, type BgsdStatePayload } from "./bridgeClient.ts";
import type { BgsdDiscovery } from "./discovery.ts";
import * as Fs from "./fsWatcher.ts";

/** The snapshot for a workspace with no bgsd at all. */
export const unavailableSnapshot = (workspaceRoot: string): BgsdWorkspaceSnapshot => ({
  workspaceRoot,
  available: false,
  source: null,
  health: null,
  run_id: null,
  state: null,
  stage: null,
  plan: null,
  agents: [],
  tokens: null,
  queue: null,
  pending_questions: [],
});

/**
 * Map a v1 `/api/state` agent-lite row onto a BgsdAgent. Enough to render;
 * the granular v2 `/api/agents` route (when present) supersedes this.
 */
const agentFromStateLite = (lite: NonNullable<BgsdStatePayload["agents"]>[number]): BgsdAgent => ({
  agent_id: lite.id ?? "unknown",
  unit_id: lite.unit ?? null,
  phase: lite.phase,
  status: lite.status,
  progress: lite.note ? { note: lite.note } : undefined,
});

/**
 * Build a snapshot from a live bridge. Prefers the granular v2 routes when the
 * health capabilities advertise them; otherwise synthesizes from `/api/state`.
 */
export const projectFromBridge = (
  discovery: BgsdDiscovery,
  client: BgsdBridgeClient,
): Effect.Effect<BgsdWorkspaceSnapshot, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const workspaceRoot = discovery.workspaceRoot;
    const health: BgsdHealth | null = discovery.health;
    const state = yield* client.state;

    const runId = state?.run_id ?? state?.run?.run_id ?? health?.run_id ?? null;

    const sessions: BgsdSessions | null = hasCapability(health, "sessions")
      ? yield* client.sessions
      : null;
    const plan: BgsdPlan | null = hasCapability(health, "plan") ? yield* client.plan(runId) : null;
    const tokens: BgsdTokensSummary | null = hasCapability(health, "tokens")
      ? yield* client.tokens(runId)
      : null;
    const queue: BgsdQueue | null = hasCapability(health, "queue") ? yield* client.queue : null;

    const v2Agents = hasCapability(health, "agents") ? yield* client.agents(runId) : null;
    const agents: ReadonlyArray<BgsdAgent> =
      v2Agents ?? (state?.agents ?? []).map(agentFromStateLite);

    const snapshot: BgsdWorkspaceSnapshot = {
      workspaceRoot,
      available: true,
      source: "bridge",
      health,
      ...(sessions ? { sessions } : {}),
      run_id: runId,
      state: state?.run?.state ?? null,
      stage: state?.stage ?? state?.run?.stage ?? null,
      plan,
      agents,
      tokens,
      queue,
      pending_questions: state?.pending_questions ?? [],
    };
    return snapshot;
  });

/**
 * Build a snapshot from the on-disk `.bgsd/` tree for a given run (defaults to
 * the newest run present).
 */
export const projectFromFs = (
  workspaceRoot: string,
  runId: string | null,
): Effect.Effect<BgsdWorkspaceSnapshot, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const resolvedRunId =
      runId ?? (yield* Fs.listRunIds(workspaceRoot).pipe(Effect.map((ids) => ids[0] ?? null)));

    if (resolvedRunId === null) {
      const queue = yield* Fs.readQueue(workspaceRoot);
      // No runs yet, but `.bgsd/` exists — still "available", just idle.
      return {
        ...unavailableSnapshot(workspaceRoot),
        available: true,
        source: "fs",
        queue,
      } satisfies BgsdWorkspaceSnapshot;
    }

    const run = yield* Fs.readRunFile(workspaceRoot, resolvedRunId);
    const agents = yield* Fs.readAgents(workspaceRoot, resolvedRunId);
    const tokens = yield* Fs.readTokens(workspaceRoot, resolvedRunId);
    const queue = yield* Fs.readQueue(workspaceRoot);

    return {
      workspaceRoot,
      available: true,
      source: "fs",
      health: null,
      run_id: resolvedRunId,
      state: run?.state ?? null,
      stage: run?.stage ?? null,
      plan: null,
      agents,
      tokens,
      queue,
      pending_questions: [],
    } satisfies BgsdWorkspaceSnapshot;
  });

// --- delta computation ------------------------------------------------------

/**
 * A cheap structural fingerprint of the parts of a snapshot that should trigger
 * a re-snapshot when they change. Deliberately excludes volatile fields like
 * agent heartbeat timestamps so idle polling stays silent; it keys on the shape
 * that actually matters to the UI (run identity/state/stage, the agent roster
 * and their phases/statuses, plan wave/unit shape, token totals, queue counts,
 * health capabilities).
 */
export const structuralKey = (snapshot: BgsdWorkspaceSnapshot): string => {
  const agents = (snapshot.agents ?? []).map((a) => ({
    id: a.agent_id,
    unit: a.unit_id ?? null,
    phase: a.phase ?? null,
    status: a.status ?? null,
  }));
  const key = {
    available: snapshot.available,
    source: snapshot.source ?? null,
    run_id: snapshot.run_id ?? null,
    state: snapshot.state ?? null,
    stage: snapshot.stage ?? null,
    agents,
    planUnits: (snapshot.plan?.units ?? []).map((u) => ({
      id: u.id,
      status: u.status ?? null,
      phase: u.phase ?? null,
    })),
    planWaves: (snapshot.plan?.waves ?? []).length,
    tokens: snapshot.tokens?.totals ?? null,
    queueCounts: snapshot.queue?.counts ?? null,
    pending: (snapshot.pending_questions ?? []).length,
    caps: snapshot.health?.capabilities ?? null,
  };
  return JSON.stringify(key);
};

/** True when two snapshots are structurally equal (no re-snapshot needed). */
export const snapshotsEqual = (
  left: BgsdWorkspaceSnapshot,
  right: BgsdWorkspaceSnapshot,
): boolean => structuralKey(left) === structuralKey(right);

/** Wrap a snapshot as a `bgsd_snapshot` push. */
export const snapshotPush = (snapshot: BgsdWorkspaceSnapshot): BgsdPush => ({
  kind: "bgsd_snapshot",
  snapshot,
});

/** Wrap an outbox batch as a `bgsd_events` push (empty batches are skipped upstream). */
export const eventsPush = (
  workspaceRoot: string,
  runId: string | null,
  events: ReadonlyArray<BgsdOutboxEvent>,
): BgsdPush => ({
  kind: "bgsd_events",
  workspaceRoot,
  run_id: runId,
  events,
});

/** Wrap an unavailable state as a `bgsd_unavailable` push. */
export const unavailablePush = (workspaceRoot: string, reason?: string): BgsdPush => ({
  kind: "bgsd_unavailable",
  workspaceRoot,
  ...(reason ? { reason } : {}),
});
