/**
 * bgsd filesystem source — the fallback when no live bridge is reachable.
 *
 * Reads the on-disk `.bgsd/` contract directly (see
 * bgsd/docs/remote-protocol.mdx and the writers in bgsd/scripts/*.mjs):
 *   - `.bgsd/runs/<run-id>/run.json`      run state / stage / scale
 *   - `.bgsd/runs/<run-id>/control/*.json` per-agent heartbeat files
 *   - `.bgsd/runs/<run-id>/remote-outbox.jsonl` append-only event log (tailed
 *     by byte offset so we only decode newly-appended lines)
 *   - `.bgsd/runs/<run-id>/tokens.json`   token ledger
 *   - `.bgsd/queue/queue.json`            fix-stream queue
 *
 * Every read tolerates a half-written file: a failed JSON decode yields null
 * and the caller retries on the next change signal. Change detection combines
 * `FileSystem.watch` (event-driven) with a periodic poll (covers platforms
 * where recursive watch is unreliable), debounced so a burst of editor writes
 * collapses into one signal.
 *
 * Uses the repo's existing `effect/FileSystem` abstraction — no chokidar, no
 * new npm dependency.
 *
 * @module bgsd/fsWatcher
 */
import { BgsdAgent, BgsdOutboxEvent, BgsdQueue, BgsdTokensSummary } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** How often to poll as a backstop when watch events are missed. */
export const DEFAULT_POLL_INTERVAL = Duration.seconds(3);
/** Debounce window collapsing bursty writes into one change signal. */
export const DEFAULT_DEBOUNCE = Duration.millis(150);

/** Raw run.json shape (the writer in gui-live.mjs). */
export const BgsdRunFile = Schema.Struct({
  run_id: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  scale: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  stage: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.String),
});
export type BgsdRunFile = typeof BgsdRunFile.Type;

/** A byte-offset cursor into an append-only outbox file. */
export interface OutboxTail {
  readonly events: ReadonlyArray<BgsdOutboxEvent>;
  /** Byte offset to resume from on the next tail call. */
  readonly nextOffset: number;
}

const decodeRunFileJson = Schema.decodeUnknownExit(Schema.fromJsonString(BgsdRunFile));
const decodeAgentJson = Schema.decodeUnknownExit(Schema.fromJsonString(BgsdAgent));
const decodeTokensJson = Schema.decodeUnknownExit(Schema.fromJsonString(BgsdTokensSummary));
const decodeQueueJson = Schema.decodeUnknownExit(Schema.fromJsonString(BgsdQueue));
const decodeOutboxEventJson = Schema.decodeUnknownExit(Schema.fromJsonString(BgsdOutboxEvent));

// --- path helpers ----------------------------------------------------------

export const runsDir = (path: Path.Path, root: string): string => path.join(root, ".bgsd", "runs");
export const runDir = (path: Path.Path, root: string, runId: string): string =>
  path.join(root, ".bgsd", "runs", runId);
export const runJsonPath = (path: Path.Path, root: string, runId: string): string =>
  path.join(runDir(path, root, runId), "run.json");
export const controlDir = (path: Path.Path, root: string, runId: string): string =>
  path.join(runDir(path, root, runId), "control");
export const outboxPath = (path: Path.Path, root: string, runId: string): string =>
  path.join(runDir(path, root, runId), "remote-outbox.jsonl");
export const tokensPath = (path: Path.Path, root: string, runId: string): string =>
  path.join(runDir(path, root, runId), "tokens.json");
export const queuePath = (path: Path.Path, root: string): string =>
  path.join(root, ".bgsd", "queue", "queue.json");

// --- readers ----------------------------------------------------------------

/** Read a JSON file with a schema, degrading to null on missing/half-written. */
const readJsonFile = <A>(
  filePath: string,
  decodeExit: (
    raw: string,
  ) => { readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure" },
): Effect.Effect<A | null, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return null;
    }
    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) {
      return null;
    }
    const decoded = decodeExit(raw);
    return decoded._tag === "Success" ? decoded.value : null;
  });

/** List run ids present under `.bgsd/runs`, newest-first by mtime. */
export const listRunIds = (
  root: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = runsDir(path, root);
    const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [];
    }
    const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
    // Only directories that actually carry a run.json are real runs.
    const withRun: Array<{ id: string; mtime: number }> = [];
    for (const id of entries) {
      const jsonPath = runJsonPath(path, root, id);
      const hasRun = yield* fs.exists(jsonPath).pipe(Effect.orElseSucceed(() => false));
      if (!hasRun) {
        continue;
      }
      const stat = yield* fs.stat(jsonPath).pipe(Effect.option);
      const mtime =
        stat._tag === "Some" && stat.value.mtime._tag === "Some"
          ? stat.value.mtime.value.getTime()
          : 0;
      withRun.push({ id, mtime });
    }
    withRun.sort((left, right) => right.mtime - left.mtime);
    return withRun.map((entry) => entry.id);
  });

export const readRunFile = (
  root: string,
  runId: string,
): Effect.Effect<BgsdRunFile | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* readJsonFile(runJsonPath(path, root, runId), decodeRunFileJson);
  });

export const readAgents = (
  root: string,
  runId: string,
): Effect.Effect<ReadonlyArray<BgsdAgent>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = controlDir(path, root, runId);
    const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return [];
    }
    const files = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
    const out: BgsdAgent[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const agent = yield* readJsonFile(path.join(dir, file), decodeAgentJson);
      if (agent !== null) {
        out.push(agent);
      }
    }
    out.sort((left, right) => left.agent_id.localeCompare(right.agent_id));
    return out;
  });

export const readTokens = (
  root: string,
  runId: string,
): Effect.Effect<BgsdTokensSummary | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* readJsonFile(tokensPath(path, root, runId), decodeTokensJson);
  });

export const readQueue = (
  root: string,
): Effect.Effect<BgsdQueue | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* readJsonFile(queuePath(path, root), decodeQueueJson);
  });

/**
 * Tail the append-only outbox from a byte offset. Reads the file as bytes,
 * decodes from `fromOffset` onward, and splits on newlines — the last partial
 * line (no trailing `\n`) is left unconsumed so `nextOffset` never points into
 * a half-written line. A truncated/rotated file (size < fromOffset) restarts
 * from 0.
 */
export const tailOutbox = (
  root: string,
  runId: string,
  fromOffset: number,
): Effect.Effect<OutboxTail, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = outboxPath(path, root, runId);
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return { events: [], nextOffset: 0 } satisfies OutboxTail;
    }
    const bytes = yield* fs.readFile(filePath).pipe(Effect.orElseSucceed(() => new Uint8Array(0)));
    // Rotation/truncation guard: restart from the beginning.
    const start = fromOffset > bytes.length ? 0 : fromOffset;
    const slice = bytes.subarray(start);
    const text = new TextDecoder().decode(slice);
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      // No complete line yet; consume nothing.
      return { events: [], nextOffset: start } satisfies OutboxTail;
    }
    const consumable = text.slice(0, lastNewline);
    const consumedBytes = new TextEncoder().encode(text.slice(0, lastNewline + 1)).length;
    const events: BgsdOutboxEvent[] = [];
    for (const line of consumable.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      const decoded = decodeOutboxEventJson(line);
      if (decoded._tag === "Success") {
        events.push(decoded.value);
      }
    }
    return { events, nextOffset: start + consumedBytes } satisfies OutboxTail;
  });

// --- change detection -------------------------------------------------------

/**
 * A debounced stream of "something under `.bgsd` changed" signals. Merges
 * recursive `FileSystem.watch` on the `.bgsd` directory with a periodic poll
 * tick, so a missed watch event is caught within one poll interval. Emits
 * `void`; the consumer re-reads whatever it needs on each tick.
 */
export const changes = (
  root: string,
  options?: {
    readonly pollInterval?: Duration.Duration;
    readonly debounce?: Duration.Duration;
  },
): Stream.Stream<void, never, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(root, ".bgsd");
      const poll = Stream.tick(options?.pollInterval ?? DEFAULT_POLL_INTERVAL);
      const watchStream = fs.watch(dir).pipe(
        Stream.map(() => undefined as void),
        // A watch error (e.g. dir removed) should not kill observation; the
        // poll keeps ticking.
        Stream.catchCause(() => Stream.empty),
      );
      return Stream.merge(watchStream, poll).pipe(
        Stream.debounce(options?.debounce ?? DEFAULT_DEBOUNCE),
      );
    }),
  );
