import * as Schema from "effect/Schema";

// kiwi-code: typed contracts for bgsd (the Kiwi Conductor) state.
// Mirrors the on-disk .bgsd/ contract and the bgsd remote bridge API v2
// (better-gsd docs/remote-protocol.mdx). bgsd JSON evolves additively, so
// these schemas are deliberately permissive: unknown keys are ignored and
// most fields are optional. Clients MUST tolerate unknown event types.

// Lifecycle and stages

export const BgsdRunState = Schema.Literals([
  "created",
  "decomposed",
  "spawning",
  "executing",
  "verifying",
  "merging",
  "checkpoint",
  "integrating",
  "review",
  "paused",
  "aborted",
  "done",
]);
export type BgsdRunState = typeof BgsdRunState.Type;

export const BgsdStage = Schema.Literals([
  "conductor",
  "loop1",
  "merge",
  "loop2",
  "review",
  "done",
]);
export type BgsdStage = typeof BgsdStage.Type;

export const BgsdAgentPhase = Schema.Literals([
  "discuss",
  "ui",
  "plan",
  "execute",
  "verify",
  "fixing",
  "done",
  "blocked",
  "failed",
]);
export type BgsdAgentPhase = typeof BgsdAgentPhase.Type;

export const BgsdHeartbeat = Schema.Literals(["alive", "stale", "dead"]);
export type BgsdHeartbeat = typeof BgsdHeartbeat.Type;

// Agents (projection of .bgsd/runs/<run>/control/<agent>.json)

export const BgsdModelAssignment = Schema.Struct({
  tier: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type BgsdModelAssignment = typeof BgsdModelAssignment.Type;

export const BgsdAgentProgress = Schema.Struct({
  iteration: Schema.optional(Schema.Number),
  max_iterations: Schema.optional(Schema.Number),
  note: Schema.optional(Schema.String),
});
export type BgsdAgentProgress = typeof BgsdAgentProgress.Type;

export const BgsdAgent = Schema.Struct({
  agent_id: Schema.String,
  unit_id: Schema.optional(Schema.NullOr(Schema.String)),
  run_id: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  model_assignment: Schema.optional(BgsdModelAssignment),
  worktree: Schema.optional(Schema.NullOr(Schema.String)),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
  heartbeat_at: Schema.optional(Schema.String),
  heartbeat: Schema.optional(BgsdHeartbeat),
  started_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  progress: Schema.optional(BgsdAgentProgress),
  context_pressure: Schema.optional(Schema.String),
  escalations: Schema.optional(Schema.Array(Schema.Unknown)),
  blockers: Schema.optional(Schema.Array(Schema.Unknown)),
  restarts: Schema.optional(Schema.Number),
  log_path: Schema.optional(Schema.String),
});
export type BgsdAgent = typeof BgsdAgent.Type;

// Units and plan (from /api/plan)

export const BgsdUnit = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  criteria: Schema.optional(Schema.Array(Schema.String)),
  touched: Schema.optional(Schema.Array(Schema.String)),
  deps: Schema.optional(Schema.Array(Schema.String)),
  difficulty: Schema.optional(Schema.Number),
  model_assignment: Schema.optional(BgsdModelAssignment),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  phase: Schema.optional(Schema.NullOr(Schema.String)),
  worktree: Schema.optional(Schema.NullOr(Schema.String)),
  branch: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BgsdUnit = typeof BgsdUnit.Type;

export const BgsdWave = Schema.Struct({
  wave: Schema.optional(Schema.Number),
  units: Schema.optional(Schema.Array(Schema.String)),
  started_at: Schema.optional(Schema.String),
  completed_at: Schema.optional(Schema.String),
});
export type BgsdWave = typeof BgsdWave.Type;

export const BgsdPlan = Schema.Struct({
  run_id: Schema.String,
  scale: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  waves: Schema.optional(Schema.Array(BgsdWave)),
  units: Schema.optional(Schema.Array(BgsdUnit)),
  checkpoints: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type BgsdPlan = typeof BgsdPlan.Type;

// Runs and sessions

export const BgsdSessionSummary = Schema.Struct({
  run_id: Schema.String,
  title: Schema.optional(Schema.String),
  scale: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  stage: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  counts: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  updated_at: Schema.optional(Schema.String),
});
export type BgsdSessionSummary = typeof BgsdSessionSummary.Type;

export const BgsdSessions = Schema.Struct({
  sessions: Schema.Array(BgsdSessionSummary),
  latest_run_id: Schema.optional(Schema.NullOr(Schema.String)),
  archived: Schema.optional(Schema.Array(Schema.String)),
});
export type BgsdSessions = typeof BgsdSessions.Type;

// Outbox events (remote-outbox.jsonl / /api/events / /api/stream).
// `type` is an open string: v2 defines narration, stage, banner, note,
// message-in, answer-in, run-state, plan-ready, wave-started, wave-done,
// agent-spawned, agent-phase, agent-escalation, agent-done, unit-merged,
// verification, control-in, tokens, issue-linked, pr-opened, pr-merged,
// branch-created. Unknown types must be ignored (rendered as narration at most).

export const BgsdOutboxEvent = Schema.Struct({
  seq: Schema.Number,
  at: Schema.optional(Schema.String),
  type: Schema.String,
  text: Schema.optional(Schema.String),
  meta: Schema.optional(Schema.Unknown),
});
export type BgsdOutboxEvent = typeof BgsdOutboxEvent.Type;

// Tokens (/api/tokens)

export const BgsdTokenTotals = Schema.Struct({
  calls: Schema.optional(Schema.Number),
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  cacheRead: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.NullOr(Schema.Number)),
  costKnown: Schema.optional(Schema.Boolean),
});
export type BgsdTokenTotals = typeof BgsdTokenTotals.Type;

export const BgsdTokensSummary = Schema.Struct({
  run_id: Schema.optional(Schema.String),
  totals: Schema.optional(BgsdTokenTotals),
  byModel: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  byRole: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  byAgent: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type BgsdTokensSummary = typeof BgsdTokensSummary.Type;

// Queue (/api/queue, .bgsd/queue/queue.json)

export const BgsdQueueItem = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  attempts: Schema.optional(Schema.Number),
  created_at: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.String),
  github_issue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        number: Schema.optional(Schema.Number),
        url: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type BgsdQueueItem = typeof BgsdQueueItem.Type;

export const BgsdQueue = Schema.Struct({
  counts: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  items: Schema.optional(Schema.Array(BgsdQueueItem)),
});
export type BgsdQueue = typeof BgsdQueue.Type;

// Bridge discovery (.bgsd/remote.json) and capabilities (/api/health)

export const BgsdBridgeInfo = Schema.Struct({
  pid: Schema.optional(Schema.Number),
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  url: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.String),
  token: Schema.optional(Schema.NullOr(Schema.String)),
  started_at: Schema.optional(Schema.String),
});
export type BgsdBridgeInfo = typeof BgsdBridgeInfo.Type;

export const BgsdCapabilities = Schema.Record(Schema.String, Schema.Boolean);
export type BgsdCapabilities = typeof BgsdCapabilities.Type;

export const BgsdHealth = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
  protocol: Schema.optional(Schema.Number),
  bgsd_version: Schema.optional(Schema.String),
  run_id: Schema.optional(Schema.NullOr(Schema.String)),
  conductor: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      emoji: Schema.optional(Schema.String),
    }),
  ),
  capabilities: Schema.optional(BgsdCapabilities),
});
export type BgsdHealth = typeof BgsdHealth.Type;

// Workspace projection: what the kiwi-code server pushes to the client.

export const BgsdWorkspaceSource = Schema.Literals(["bridge", "fs"]);
export type BgsdWorkspaceSource = typeof BgsdWorkspaceSource.Type;

export const BgsdWorkspaceSnapshot = Schema.Struct({
  workspaceRoot: Schema.String,
  available: Schema.Boolean,
  source: Schema.optional(Schema.NullOr(BgsdWorkspaceSource)),
  health: Schema.optional(Schema.NullOr(BgsdHealth)),
  sessions: Schema.optional(BgsdSessions),
  run_id: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  stage: Schema.optional(Schema.NullOr(Schema.String)),
  plan: Schema.optional(Schema.NullOr(BgsdPlan)),
  agents: Schema.optional(Schema.Array(BgsdAgent)),
  tokens: Schema.optional(Schema.NullOr(BgsdTokensSummary)),
  queue: Schema.optional(Schema.NullOr(BgsdQueue)),
  pending_questions: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type BgsdWorkspaceSnapshot = typeof BgsdWorkspaceSnapshot.Type;

// Server -> client push events for the Kiwi UI.

export const BgsdPush = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("bgsd_snapshot"),
    snapshot: BgsdWorkspaceSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("bgsd_events"),
    workspaceRoot: Schema.String,
    run_id: Schema.optional(Schema.NullOr(Schema.String)),
    events: Schema.Array(BgsdOutboxEvent),
  }),
  Schema.Struct({
    kind: Schema.Literal("bgsd_unavailable"),
    workspaceRoot: Schema.String,
    reason: Schema.optional(Schema.String),
  }),
]);
export type BgsdPush = typeof BgsdPush.Type;
