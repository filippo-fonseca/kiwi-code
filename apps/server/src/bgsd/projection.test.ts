// @effect-diagnostics preferSchemaOverJson:off - test fixtures write raw .bgsd JSON on disk.
// @effect-diagnostics globalDateInEffect:off - fixtures set explicit mtimes.
import type { BgsdWorkspaceSnapshot } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  eventsPush,
  projectFromFs,
  snapshotPush,
  snapshotsEqual,
  structuralKey,
  unavailablePush,
  unavailableSnapshot,
} from "./projection.ts";

const baseSnapshot = (overrides: Partial<BgsdWorkspaceSnapshot> = {}): BgsdWorkspaceSnapshot => ({
  ...unavailableSnapshot("/ws"),
  available: true,
  source: "fs",
  run_id: "run-1",
  state: "executing",
  stage: "loop1",
  agents: [{ agent_id: "auth", unit_id: "auth", phase: "plan", status: "running" }],
  ...overrides,
});

const seedRun = (
  root: string,
  runId: string,
  files: { run?: unknown; agents?: Record<string, unknown> },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(root, ".bgsd", "runs", runId);
    yield* fs.makeDirectory(dir, { recursive: true });
    if (files.run !== undefined) {
      yield* fs.writeFileString(path.join(dir, "run.json"), JSON.stringify(files.run));
    }
    if (files.agents) {
      const control = path.join(dir, "control");
      yield* fs.makeDirectory(control, { recursive: true });
      for (const [id, a] of Object.entries(files.agents)) {
        yield* fs.writeFileString(path.join(control, `${id}.json`), JSON.stringify(a));
      }
    }
  });

describe("bgsd/projection structuralKey", () => {
  it("treats structurally-identical snapshots as equal", () => {
    assert.isTrue(snapshotsEqual(baseSnapshot(), baseSnapshot()));
  });

  it("ignores volatile heartbeat timestamps (idle poll stays silent)", () => {
    const a = baseSnapshot({
      agents: [{ agent_id: "auth", phase: "plan", status: "running", heartbeat_at: "t1" }],
    });
    const b = baseSnapshot({
      agents: [{ agent_id: "auth", phase: "plan", status: "running", heartbeat_at: "t2" }],
    });
    assert.isTrue(snapshotsEqual(a, b));
  });

  it("detects a run state change", () => {
    assert.isFalse(snapshotsEqual(baseSnapshot(), baseSnapshot({ state: "verifying" })));
  });

  it("detects an agent phase change", () => {
    const next = baseSnapshot({
      agents: [{ agent_id: "auth", unit_id: "auth", phase: "execute", status: "running" }],
    });
    assert.isFalse(snapshotsEqual(baseSnapshot(), next));
  });

  it("detects an agent joining the roster", () => {
    const next = baseSnapshot({
      agents: [
        { agent_id: "auth", unit_id: "auth", phase: "plan", status: "running" },
        { agent_id: "ui", unit_id: "ui", phase: "plan", status: "running" },
      ],
    });
    assert.isFalse(snapshotsEqual(baseSnapshot(), next));
  });

  it("detects a queue-count change", () => {
    const a = baseSnapshot({ queue: { counts: { queued: 1 } } });
    const b = baseSnapshot({ queue: { counts: { queued: 2 } } });
    assert.isFalse(snapshotsEqual(a, b));
  });

  it("produces a stable string key", () => {
    assert.strictEqual(structuralKey(baseSnapshot()), structuralKey(baseSnapshot()));
  });
});

describe("bgsd/projection push wrappers", () => {
  it("wraps a snapshot push", () => {
    const push = snapshotPush(baseSnapshot());
    assert.strictEqual(push.kind, "bgsd_snapshot");
  });

  it("wraps an events push", () => {
    const push = eventsPush("/ws", "run-1", [{ seq: 1, type: "narration", text: "hi" }]);
    assert.deepEqual(push, {
      kind: "bgsd_events",
      workspaceRoot: "/ws",
      run_id: "run-1",
      events: [{ seq: 1, type: "narration", text: "hi" }],
    });
  });

  it("wraps an unavailable push with an optional reason", () => {
    assert.deepEqual(unavailablePush("/ws", "no bgsd"), {
      kind: "bgsd_unavailable",
      workspaceRoot: "/ws",
      reason: "no bgsd",
    });
    assert.deepEqual(unavailablePush("/ws"), {
      kind: "bgsd_unavailable",
      workspaceRoot: "/ws",
    });
  });
});

describe("bgsd/projection projectFromFs", () => {
  it.effect("projects the on-disk run into a snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-proj-fs-" });
      yield* seedRun(root, "run-1", {
        run: { run_id: "run-1", state: "executing", stage: "loop1" },
        agents: { auth: { agent_id: "auth", unit_id: "auth", phase: "plan", status: "running" } },
      });

      const snapshot = yield* projectFromFs(root, "run-1");
      assert.strictEqual(snapshot.available, true);
      assert.strictEqual(snapshot.source, "fs");
      assert.strictEqual(snapshot.run_id, "run-1");
      assert.strictEqual(snapshot.state, "executing");
      assert.strictEqual(snapshot.stage, "loop1");
      assert.deepEqual(
        (snapshot.agents ?? []).map((a) => a.agent_id),
        ["auth"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves the newest run when none is specified", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-proj-newest-" });
      yield* seedRun(root, "run-old", { run: { run_id: "run-old", state: "done" } });
      yield* seedRun(root, "run-new", { run: { run_id: "run-new", state: "executing" } });
      const runJson = (id: string) => path.join(root, ".bgsd", "runs", id, "run.json");
      yield* fs.utimes(runJson("run-old"), new Date(1_000), new Date(1_000));
      yield* fs.utimes(runJson("run-new"), new Date(2_000), new Date(2_000));

      const snapshot = yield* projectFromFs(root, null);
      assert.strictEqual(snapshot.run_id, "run-new");
      assert.strictEqual(snapshot.state, "executing");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports available-but-idle when .bgsd has no runs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-proj-idle-" });
      yield* fs.makeDirectory(path.join(root, ".bgsd", "queue"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".bgsd", "queue", "queue.json"),
        JSON.stringify({ items: [{ id: "q1", title: "later" }] }),
      );

      const snapshot = yield* projectFromFs(root, null);
      assert.strictEqual(snapshot.available, true);
      assert.strictEqual(snapshot.source, "fs");
      assert.strictEqual(snapshot.run_id, null);
      assert.strictEqual(snapshot.queue?.items?.[0]?.id, "q1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
