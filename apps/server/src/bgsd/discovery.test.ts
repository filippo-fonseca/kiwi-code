// @effect-diagnostics preferSchemaOverJson:off - test fixtures write raw remote.json on disk.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";

import { bridgeBaseUrl, classifyWorkspace, readBridgePointer } from "./discovery.ts";

const testLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

/** Write a `.bgsd/remote.json` pointer under `root`. */
const writePointer = (root: string, pointer: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(root, ".bgsd"), { recursive: true });
    yield* fs.writeFileString(path.join(root, ".bgsd", "remote.json"), JSON.stringify(pointer));
  });

describe("bgsd/discovery bridgeBaseUrl", () => {
  it("prefers the explicit url and trims trailing slashes", () => {
    assert.strictEqual(bridgeBaseUrl({ url: "http://localhost:5000/" }), "http://localhost:5000");
  });

  it("falls back to host:port", () => {
    assert.strictEqual(bridgeBaseUrl({ host: "127.0.0.1", port: 5051 }), "http://127.0.0.1:5051");
  });

  it("defaults the host to loopback when only a port is given", () => {
    assert.strictEqual(bridgeBaseUrl({ port: 5052 }), "http://127.0.0.1:5052");
  });

  it("returns null when neither url nor port is present", () => {
    assert.strictEqual(bridgeBaseUrl({ pid: 1 }), null);
  });
});

describe("bgsd/discovery readBridgePointer", () => {
  it.effect("returns null when no pointer exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-ptr-none-" });
      const pointer = yield* readBridgePointer(root);
      assert.strictEqual(pointer, null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("parses a well-formed pointer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-ptr-ok-" });
      yield* writePointer(root, {
        pid: 42,
        host: "127.0.0.1",
        port: 5099,
        url: "http://127.0.0.1:5099",
        run_id: "run-1",
        token: null,
        started_at: "2026-07-05T00:00:00.000Z",
      });
      const pointer = yield* readBridgePointer(root);
      assert.strictEqual(pointer?.port, 5099);
      assert.strictEqual(pointer?.run_id, "run-1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tolerates a half-written pointer (returns null)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-ptr-partial-" });
      yield* fs.makeDirectory(path.join(root, ".bgsd"), { recursive: true });
      yield* fs.writeFileString(path.join(root, ".bgsd", "remote.json"), '{"pid":42,"port":');
      const pointer = yield* readBridgePointer(root);
      assert.strictEqual(pointer, null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("bgsd/discovery classifyWorkspace", () => {
  it.effect("classifies no-bgsd when there is no .bgsd directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-cls-none-" });
      const result = yield* classifyWorkspace(root);
      assert.strictEqual(result.classification, "no-bgsd");
      assert.strictEqual(result.bridge, null);
      assert.strictEqual(result.health, null);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("classifies bgsd-no-bridge when .bgsd exists but no pointer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-cls-nobridge-" });
      yield* fs.makeDirectory(path.join(root, ".bgsd", "runs"), { recursive: true });
      const result = yield* classifyWorkspace(root);
      assert.strictEqual(result.classification, "bgsd-no-bridge");
      assert.strictEqual(result.bridge, null);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("classifies bgsd-no-bridge when the pointer targets a dead port", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "bgsd-cls-dead-" });
      // Port 1 is not listening; the health check fails within the timeout.
      yield* writePointer(root, {
        pid: 1,
        host: "127.0.0.1",
        port: 1,
        url: "http://127.0.0.1:1",
        run_id: "run-1",
        token: null,
        started_at: "2026-07-05T00:00:00.000Z",
      });
      const result = yield* classifyWorkspace(root, { timeout: Duration.millis(500) });
      assert.strictEqual(result.classification, "bgsd-no-bridge");
      // The pointer is still surfaced even though the bridge is unreachable.
      assert.strictEqual(result.bridge?.port, 1);
      assert.strictEqual(result.bridgeUrl, "http://127.0.0.1:1");
      assert.strictEqual(result.health, null);
    }).pipe(Effect.provide(testLayer)),
  );
});
