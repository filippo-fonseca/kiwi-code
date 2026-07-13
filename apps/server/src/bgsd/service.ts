/**
 * bgsd workspace service — the Effect Layer that ties discovery, the bridge
 * client, the filesystem fallback, and the projection into a single
 * `Stream<BgsdPush>` the WebSocket RPC handler subscribes to.
 *
 * Per subscription:
 *   1. Classify the workspace (discovery). Prefer a live bridge; else fall back
 *      to the filesystem watcher; else report unavailable.
 *   2. Emit an initial `bgsd_snapshot` (or `bgsd_unavailable`).
 *   3. Stream deltas:
 *        - bridge: SSE outbox events -> `bgsd_events`, plus a periodic (30s)
 *          re-probe that re-snapshots on a structural change.
 *        - fs: on each debounced change signal, re-read the snapshot (emit a
 *          fresh `bgsd_snapshot` only on structural change) and tail the outbox
 *          (emit `bgsd_events` for new lines). A periodic re-probe upgrades to
 *          the bridge if one comes up.
 *        - no-bgsd: a periodic re-probe that upgrades if bgsd appears.
 *
 * The re-probe interval lets a session that starts without a bridge (or without
 * bgsd at all) transparently upgrade once the Conductor starts one.
 *
 * @module bgsd/service
 */
import { type BgsdPush } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { makeBgsdBridgeClient } from "./bridgeClient.ts";
import { classifyWorkspace, type BgsdDiscovery } from "./discovery.ts";
import * as Fs from "./fsWatcher.ts";
import * as Projection from "./projection.ts";

/** How often to re-probe the bridge to upgrade a fs/no-bgsd subscription. */
export const DEFAULT_REPROBE_INTERVAL = Duration.seconds(30);

/** Environment every push stream needs. */
export type BgsdServiceEnv = HttpClient.HttpClient | FileSystem.FileSystem | Path.Path;

export interface BgsdWorkspaceServiceShape {
  /** A stream of pushes for a workspace root: snapshot first, then deltas. */
  readonly subscribe: (workspaceRoot: string) => Stream.Stream<BgsdPush, never, BgsdServiceEnv>;
}

export class BgsdWorkspaceService extends Context.Service<
  BgsdWorkspaceService,
  BgsdWorkspaceServiceShape
>()("t3/bgsd/service/BgsdWorkspaceService") {}

const reprobe = DEFAULT_REPROBE_INTERVAL;

/**
 * The bridge branch: initial snapshot, then SSE deltas merged with a periodic
 * re-snapshot probe (structural gate keeps idle probes silent).
 */
const bridgeStream = (discovery: BgsdDiscovery): Stream.Stream<BgsdPush, never, BgsdServiceEnv> => {
  const baseUrl = discovery.bridgeUrl;
  if (baseUrl === null) {
    return Stream.make(
      Projection.unavailablePush(discovery.workspaceRoot, "bridge url unavailable"),
    );
  }
  const client = makeBgsdBridgeClient({
    baseUrl,
    token: discovery.bridge?.token ?? null,
  });
  return Stream.unwrap(
    Effect.gen(function* () {
      const initial = yield* Projection.projectFromBridge(discovery, client);
      const lastKey = yield* Ref.make(Projection.structuralKey(initial));

      const reprobed = Stream.tick(reprobe).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const next = yield* Projection.projectFromBridge(discovery, client);
            const key = Projection.structuralKey(next);
            const prev = yield* Ref.getAndSet(lastKey, key);
            return key === prev ? null : Projection.snapshotPush(next);
          }),
        ),
        Stream.filter(Predicate.isNotNull),
      );

      const events = client
        .streamEvents(0)
        .pipe(
          Stream.map((event) =>
            Projection.eventsPush(discovery.workspaceRoot, initial.run_id ?? null, [event]),
          ),
        );

      return Stream.concat(
        Stream.make(Projection.snapshotPush(initial)),
        Stream.merge(events, reprobed),
      );
    }),
  );
};

/**
 * The filesystem branch: initial snapshot, then on each debounced change
 * re-read + re-snapshot (structural gate) and tail the outbox.
 */
const fsStream = (discovery: BgsdDiscovery): Stream.Stream<BgsdPush, never, BgsdServiceEnv> => {
  const root = discovery.workspaceRoot;
  return Stream.unwrap(
    Effect.gen(function* () {
      const runIds = yield* Fs.listRunIds(root);
      const runId = runIds[0] ?? null;
      const initial = yield* Projection.projectFromFs(root, runId);
      const lastKey = yield* Ref.make(Projection.structuralKey(initial));
      const offset = yield* Ref.make(0);
      const activeRun = yield* Ref.make(runId);

      const onChange = Fs.changes(root).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const currentRunIds = yield* Fs.listRunIds(root);
            const currentRun = currentRunIds[0] ?? null;
            // On a run switch, reset the outbox cursor.
            const previousRun = yield* Ref.getAndSet(activeRun, currentRun);
            if (previousRun !== currentRun) {
              yield* Ref.set(offset, 0);
            }

            const pushes: BgsdPush[] = [];

            const next = yield* Projection.projectFromFs(root, currentRun);
            const key = Projection.structuralKey(next);
            const prev = yield* Ref.getAndSet(lastKey, key);
            if (key !== prev) {
              pushes.push(Projection.snapshotPush(next));
            }

            if (currentRun !== null) {
              const from = yield* Ref.get(offset);
              const tail = yield* Fs.tailOutbox(root, currentRun, from);
              yield* Ref.set(offset, tail.nextOffset);
              if (tail.events.length > 0) {
                pushes.push(Projection.eventsPush(root, currentRun, tail.events));
              }
            }

            return pushes;
          }),
        ),
        Stream.flattenIterable,
      );

      return Stream.concat(Stream.make(Projection.snapshotPush(initial)), onChange);
    }),
  );
};

/**
 * Subscribe to workspace pushes. Classifies once, dispatches to the right
 * branch, and (for fs/no-bgsd) races a re-probe that upgrades to the bridge
 * branch mid-stream when a bridge becomes reachable.
 */
const subscribe = (workspaceRoot: string): Stream.Stream<BgsdPush, never, BgsdServiceEnv> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const discovery = yield* classifyWorkspace(workspaceRoot);

      if (discovery.classification === "bridge-live") {
        return bridgeStream(discovery);
      }

      const base: Stream.Stream<BgsdPush, never, BgsdServiceEnv> =
        discovery.classification === "bgsd-no-bridge"
          ? fsStream(discovery)
          : Stream.make(Projection.unavailablePush(workspaceRoot, "no bgsd in workspace"));

      // Splice in an upgrade probe: the first time it sees a live bridge it
      // hands off to the bridge stream (which re-emits a fresh snapshot). The
      // base stream keeps flowing; the UI treats the newest snapshot as
      // authoritative.
      const upgrade = Stream.tick(reprobe).pipe(
        Stream.mapEffect(() => classifyWorkspace(workspaceRoot)),
        Stream.filter((d) => d.classification === "bridge-live"),
        Stream.take(1),
        Stream.flatMap((d) => bridgeStream(d)),
      );

      return Stream.merge(base, upgrade);
    }),
  );

export const make: Effect.Effect<BgsdWorkspaceServiceShape> = Effect.succeed({ subscribe });

export const layer = Layer.effect(BgsdWorkspaceService, make);
