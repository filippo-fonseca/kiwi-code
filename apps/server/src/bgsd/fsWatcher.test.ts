// @effect-diagnostics preferSchemaOverJson:off - test fixtures write raw .bgsd JSON on disk.
// @effect-diagnostics globalDate:off - fixtures set explicit mtimes/timestamps.
// @effect-diagnostics globalDateInEffect:off - fixtures set explicit mtimes/timestamps.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  listRunIds,
  readAgents,
  readQueue,
  readRunFile,
  readTokens,
  tailOutbox,
} from "./fsWatcher.ts";

/** Build a minimal `.bgsd` tree under `root` for a single run. */
const seedRun = (
  root: string,
  runId: string,
  files: {
    readonly run?: unknown;
    readonly agents?: Readonly<Record<string, unknown>>;
    readonly tokens?: unknown;
    readonly outbox?: string;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runDir = path.join(root, ".bgsd", "runs", runId);
    yield* fs.makeDirectory(runDir, { recursive: true });
    if (files.run !== undefined) {
      yield* fs.writeFileString(path.join(runDir, "run.json"), JSON.stringify(files.run));
    }
    if (files.tokens !== undefined) {
      yield* fs.writeFileString(path.join(runDir, "tokens.json"), JSON.stringify(files.tokens));
    }
    if (files.outbox !== undefined) {
      yield* fs.writeFileString(path.join(runDir, "remote-outbox.jsonl"), files.outbox);
    }
    if (files.agents) {
      const controlDir = path.join(runDir, "control");
      yield* fs.makeDirectory(controlDir, { recursive: true });
      for (const [agentId, agent] of Object.entries(files.agents)) {
        yield* fs.writeFileString(path.join(controlDir, `${agentId}.json`), JSON.stringify(agent));
      }
    }
  });

const outboxLine = (seq: number, type = "narration", text = `event-${seq}`) =>
  `${JSON.stringify({ seq, at: new Date(seq).toISOString(), type, text })}\n`;

describe("bgsd/fsWatcher readers", () => {
  it.effect("reads run.json / agents / tokens / queue", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-fs-readers-" });
      yield* seedRun(root, "run-1", {
        run: { run_id: "run-1", state: "executing", stage: "loop1", scale: "feature" },
        agents: {
          auth: { agent_id: "auth", unit_id: "auth", phase: "plan", status: "running" },
          ui: { agent_id: "ui", unit_id: "ui", phase: "execute", status: "running" },
        },
        tokens: { run_id: "run-1", totals: { calls: 3, input: 100, output: 50 } },
      });
      yield* fs.makeDirectory(path.join(root, ".bgsd", "queue"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".bgsd", "queue", "queue.json"),
        JSON.stringify({ items: [{ id: "item-1", title: "Fix nav", state: "queued" }] }),
      );

      const run = yield* readRunFile(root, "run-1");
      assert.strictEqual(run?.state, "executing");
      assert.strictEqual(run?.stage, "loop1");

      const agents = yield* readAgents(root, "run-1");
      // Sorted by agent_id.
      assert.deepEqual(
        agents.map((a) => a.agent_id),
        ["auth", "ui"],
      );

      const tokens = yield* readTokens(root, "run-1");
      assert.strictEqual(tokens?.totals?.calls, 3);

      const queue = yield* readQueue(root);
      assert.strictEqual(queue?.items?.[0]?.id, "item-1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists run ids newest-first and skips dirs without run.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-fs-runs-" });
      yield* seedRun(root, "run-old", { run: { run_id: "run-old" } });
      // A stray dir with no run.json must be ignored.
      yield* fs.makeDirectory(path.join(root, ".bgsd", "runs", "stdout-test-123"), {
        recursive: true,
      });
      yield* seedRun(root, "run-new", { run: { run_id: "run-new" } });

      // Set explicit mtimes rather than sleeping (it.effect runs on the test
      // clock, so real-time sleeps never resolve). run-new is newer.
      const runJson = (id: string) => path.join(root, ".bgsd", "runs", id, "run.json");
      yield* fs.utimes(runJson("run-old"), new Date(1_000), new Date(1_000));
      yield* fs.utimes(runJson("run-new"), new Date(2_000), new Date(2_000));

      const ids = yield* listRunIds(root);
      assert.deepEqual(ids, ["run-new", "run-old"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns empty run list when .bgsd is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-fs-empty-" });
      const ids = yield* listRunIds(root);
      assert.deepEqual(ids, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("bgsd/fsWatcher tailOutbox cursoring", () => {
  it.effect("returns all complete lines from offset 0 and advances the cursor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-tail-" });
      const content = outboxLine(1) + outboxLine(2) + outboxLine(3);
      yield* seedRun(root, "run-1", { outbox: content });

      const first = yield* tailOutbox(root, "run-1", 0);
      assert.deepEqual(
        first.events.map((e) => e.seq),
        [1, 2, 3],
      );
      assert.strictEqual(first.nextOffset, Buffer.byteLength(content));

      // Tailing again from the cursor yields nothing new.
      const second = yield* tailOutbox(root, "run-1", first.nextOffset);
      assert.deepEqual(second.events, []);
      assert.strictEqual(second.nextOffset, first.nextOffset);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("only emits newly-appended lines on the next tail", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-tail-append-" });
      const outboxFile = path.join(root, ".bgsd", "runs", "run-1", "remote-outbox.jsonl");
      yield* seedRun(root, "run-1", { outbox: outboxLine(1) });

      const first = yield* tailOutbox(root, "run-1", 0);
      assert.deepEqual(
        first.events.map((e) => e.seq),
        [1],
      );

      // Append more.
      const appended = outboxLine(2) + outboxLine(3);
      yield* fs.writeFileString(outboxFile, outboxLine(1) + appended);

      const second = yield* tailOutbox(root, "run-1", first.nextOffset);
      assert.deepEqual(
        second.events.map((e) => e.seq),
        [2, 3],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never consumes a half-written trailing line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-tail-partial-" });
      // Second line has no trailing newline yet (mid-write).
      const partial = outboxLine(1) + '{"seq":2,"type":"narration"';
      yield* seedRun(root, "run-1", { outbox: partial });

      const result = yield* tailOutbox(root, "run-1", 0);
      // Only the first, complete line is consumed.
      assert.deepEqual(
        result.events.map((e) => e.seq),
        [1],
      );
      // The cursor stops right after the first line, before the partial.
      assert.strictEqual(result.nextOffset, Buffer.byteLength(outboxLine(1)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("restarts from 0 when the file is truncated below the cursor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-tail-truncate-" });
      const big = outboxLine(1) + outboxLine(2) + outboxLine(3);
      yield* seedRun(root, "run-1", { outbox: big });
      const first = yield* tailOutbox(root, "run-1", 0);
      const staleCursor = first.nextOffset;

      // Rotation: file replaced with a shorter one.
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(root, ".bgsd", "runs", "run-1", "remote-outbox.jsonl"),
        outboxLine(9),
      );

      const afterRotate = yield* tailOutbox(root, "run-1", staleCursor);
      assert.deepEqual(
        afterRotate.events.map((e) => e.seq),
        [9],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("consumes nothing (offset unchanged) when no complete line exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-tail-none-" });
      yield* seedRun(root, "run-1", { outbox: '{"seq":1,"type":"x"' });
      const result = yield* tailOutbox(root, "run-1", 0);
      assert.deepEqual(result.events, []);
      assert.strictEqual(result.nextOffset, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns empty when the outbox file is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-tail-absent-" });
      yield* seedRun(root, "run-1", { run: { run_id: "run-1" } });
      const result = yield* tailOutbox(root, "run-1", 0);
      assert.deepEqual(result.events, []);
      assert.strictEqual(result.nextOffset, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
