/**
 * bgsd discovery — classify a workspace's Kiwi Conductor state.
 *
 * Given a workspace root, decide how the server should observe bgsd:
 *   - `bridge-live`: a `.bgsd/remote.json` pointer exists AND its HTTP bridge
 *     answers `GET /api/health` within a short timeout. The live client
 *     (bridgeClient.ts) should be preferred.
 *   - `bgsd-no-bridge`: `.bgsd/` exists but there is no reachable bridge
 *     (no pointer, stale pointer, or health-check failed). Fall back to the
 *     filesystem watcher (fsWatcher.ts).
 *   - `no-bgsd`: no `.bgsd/` directory at all. Nothing to observe.
 *
 * This module NEVER starts a bridge. If auto-start is ever wanted, the hook
 * belongs where `bgsd-no-bridge` is returned in {@link classifyWorkspace}:
 * spawn `node <plugin>/scripts/remote.mjs` (see bgsd/commands/bgsd-remote.md),
 * poll for the pointer, then re-run discovery. Kept out of this unit on
 * purpose so discovery stays a pure, side-effect-light probe.
 *
 * @module bgsd/discovery
 */
import { BgsdBridgeInfo, BgsdHealth } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/** How long we wait for a bridge health check before declaring it dead. */
export const DEFAULT_HEALTH_TIMEOUT = Duration.seconds(2);

export type BgsdDiscoveryClassification = "bridge-live" | "bgsd-no-bridge" | "no-bgsd";

export interface BgsdDiscovery {
  readonly workspaceRoot: string;
  readonly classification: BgsdDiscoveryClassification;
  /** Parsed `.bgsd/remote.json`, when present and well-formed. */
  readonly bridge: BgsdBridgeInfo | null;
  /** The bridge base URL to talk to, when `bridge-live`. */
  readonly bridgeUrl: string | null;
  /** Health payload from the live bridge, when `bridge-live`. */
  readonly health: BgsdHealth | null;
}

/** Decode `.bgsd/remote.json` straight from its raw JSON string. */
const decodeBridgeInfoJson = Schema.decodeUnknownExit(Schema.fromJsonString(BgsdBridgeInfo));
const decodeHealth = Schema.decodeUnknownExit(BgsdHealth);

/** Absolute path to the `.bgsd` directory for a workspace root. */
export const bgsdDir = (path: Path.Path, workspaceRoot: string): string =>
  path.join(workspaceRoot, ".bgsd");

/** Absolute path to `.bgsd/remote.json`. */
export const remotePointerPath = (path: Path.Path, workspaceRoot: string): string =>
  path.join(workspaceRoot, ".bgsd", "remote.json");

/**
 * Derive the bridge base URL from a pointer. Prefers the explicit `url`; falls
 * back to `http://<host>:<port>`. Returns null when neither is available.
 */
export const bridgeBaseUrl = (bridge: BgsdBridgeInfo): string | null => {
  if (typeof bridge.url === "string" && bridge.url.length > 0) {
    return bridge.url.replace(/\/+$/, "");
  }
  if (typeof bridge.port === "number") {
    const host = bridge.host && bridge.host.length > 0 ? bridge.host : "127.0.0.1";
    return `http://${host}:${bridge.port}`;
  }
  return null;
};

/**
 * Read and validate `.bgsd/remote.json`. Tolerates a missing or half-written
 * file (returns null rather than failing) so callers can degrade gracefully.
 */
export const readBridgePointer = (
  workspaceRoot: string,
): Effect.Effect<BgsdBridgeInfo | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pointerPath = remotePointerPath(path, workspaceRoot);
    const exists = yield* fs.exists(pointerPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return null;
    }
    const raw = yield* fs.readFileString(pointerPath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) {
      return null;
    }
    // Tolerate a half-written file: a failed decode yields null, and the
    // caller retries on the next probe/watch tick.
    const decoded = decodeBridgeInfoJson(raw);
    return decoded._tag === "Success" ? decoded.value : null;
  });

/**
 * Health-check a bridge base URL with a short timeout. Returns the decoded
 * health payload on success, or null on any failure (unreachable, timeout,
 * non-2xx, unparseable). `token` (when present) is sent both as an
 * `Authorization: Bearer` and `X-Bgsd-Token` header; loopback bridges are
 * often tokenless and ignore it.
 */
export const healthCheck = (
  bridgeUrl: string,
  options?: { readonly token?: string | null; readonly timeout?: Duration.Duration },
): Effect.Effect<BgsdHealth | null, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.get(`${bridgeUrl}/api/health`);
    if (options?.token) {
      request = request.pipe(
        HttpClientRequest.bearerToken(options.token),
        HttpClientRequest.setHeader("X-Bgsd-Token", options.token),
      );
    }
    const body = yield* client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeoutOption(options?.timeout ?? DEFAULT_HEALTH_TIMEOUT),
      Effect.orElseSucceed(() => null),
    );
    if (body === null || body._tag === "None") {
      return null;
    }
    const decoded = decodeHealth(body.value);
    return decoded._tag === "Success" ? decoded.value : null;
  });

/**
 * Classify a workspace root: does bgsd exist, and is a live bridge reachable?
 */
export const classifyWorkspace = (
  workspaceRoot: string,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<BgsdDiscovery, never, FileSystem.FileSystem | Path.Path | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const dir = bgsdDir(path, workspaceRoot);
    const hasBgsd = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
    if (!hasBgsd) {
      return {
        workspaceRoot,
        classification: "no-bgsd",
        bridge: null,
        bridgeUrl: null,
        health: null,
      } satisfies BgsdDiscovery;
    }

    const bridge = yield* readBridgePointer(workspaceRoot);
    const bridgeUrl = bridge ? bridgeBaseUrl(bridge) : null;

    if (bridge && bridgeUrl) {
      const health = yield* healthCheck(bridgeUrl, {
        token: bridge.token ?? null,
        ...(options?.timeout ? { timeout: options.timeout } : {}),
      });
      if (health !== null) {
        return {
          workspaceRoot,
          classification: "bridge-live",
          bridge,
          bridgeUrl,
          health,
        } satisfies BgsdDiscovery;
      }
    }

    // `.bgsd/` present but no reachable bridge. Auto-start hook would go here.
    return {
      workspaceRoot,
      classification: "bgsd-no-bridge",
      bridge,
      bridgeUrl,
      health: null,
    } satisfies BgsdDiscovery;
  });
