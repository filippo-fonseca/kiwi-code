import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";

const TestServerConfig = ServerConfig.layerTestSync();

const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: (input) =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cwd: input.cwd,
        cause: PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "PowerShell is not installed in the test environment",
        }),
      }),
    ),
});

const makeProbeFailureLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        TestServerConfig,
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProcessRunner,
      Net.layer,
      Layer.succeed(HostProcessPlatform, "win32"),
      TestServerConfig,
    ),
  ),
);

const openServer = (port: number): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
) {
  for (const port of ports) {
    const server = yield* openServer(port);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS),
  ({ server }) => closeServer(server),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns a server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe((servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);

const discoveredServer = (port: number): DiscoveredLocalServer => ({
  host: "localhost",
  port,
  url: `http://localhost:${port}`,
  processName: null,
  pid: null,
  terminal: null,
});

effectIt("selfListeningPorts includes the backend port and the dev-url web port", () =>
  Effect.sync(() => {
    const ports = PortScanner.selfListeningPorts({
      port: 13773,
      devUrl: new URL("http://localhost:5733"),
    });
    expect(ports.has(13773)).toBe(true);
    expect(ports.has(5733)).toBe(true);
    expect(ports.size).toBe(2);
  }),
);

effectIt("selfListeningPorts ignores an unbound (0) backend port and missing dev-url", () =>
  Effect.sync(() => {
    const ports = PortScanner.selfListeningPorts({ port: 0, devUrl: undefined });
    expect(ports.size).toBe(0);
  }),
);

effectIt("selfListeningPorts covers packaged mode where devUrl is absent", () =>
  Effect.sync(() => {
    const ports = PortScanner.selfListeningPorts({ port: 3773, devUrl: undefined });
    expect(ports.has(3773)).toBe(true);
    expect(ports.size).toBe(1);
  }),
);

effectIt("excludeSelfPorts drops only the editor's own ports", () =>
  Effect.sync(() => {
    const servers = [discoveredServer(3000), discoveredServer(5733), discoveredServer(13773)];
    const filtered = PortScanner.excludeSelfPorts(servers, new Set([5733, 13773]));
    expect(filtered.map((server) => server.port)).toEqual([3000]);
  }),
);

effectIt("excludeSelfPorts is a no-op when there are no self ports", () =>
  Effect.sync(() => {
    const servers = [discoveredServer(3000), discoveredServer(5733)];
    const filtered = PortScanner.excludeSelfPorts(servers, new Set());
    expect(filtered).toBe(servers);
  }),
);

/**
 * End-to-end proof that the editor's own listening port never surfaces as a
 * discovered candidate: we open a real listener, tell the scanner (via
 * ServerConfig) that this port is the editor's own web dev port, and confirm the
 * scan omits it while still returning a sibling project server.
 */
effectIt("scan() excludes the editor's own listening port", () =>
  Effect.gen(function* () {
    const { port: selfPort, server: selfServer } = yield* openCommonDevServer(
      PortScanner.COMMON_DEV_PORTS,
    );
    const projectPort = PortScanner.COMMON_DEV_PORTS.find((candidate) => candidate !== selfPort);
    if (projectPort === undefined) {
      yield* closeServer(selfServer);
      return yield* Effect.die(new Error("expected a second common dev port for the test"));
    }
    const projectServer = yield* openServer(projectPort);
    if (projectServer === null) {
      yield* closeServer(selfServer);
      return yield* Effect.die(new Error("could not open the sibling project server for the test"));
    }

    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          TestProcessRunner,
          Net.layer,
          Layer.succeed(HostProcessPlatform, "win32"),
          ServerConfig.layerTestSync({ devUrl: new URL(`http://localhost:${selfPort}`) }),
        ),
      ),
    );

    const result = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) =>
      scanner.scan(),
    ).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.zip(closeServer(selfServer), closeServer(projectServer))),
    );

    expect(result.some((server) => server.port === selfPort)).toBe(false);
    expect(result.some((server) => server.port === projectPort)).toBe(true);
  }),
);
