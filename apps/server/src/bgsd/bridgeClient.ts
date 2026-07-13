/**
 * bgsd bridge client — a minimal, typed HTTP client for a running Kiwi
 * Conductor bridge (see bgsd/docs/remote-protocol.mdx).
 *
 * Routes:
 *   v1 (always): GET /api/health, /api/state, /api/events?since=, /api/stream
 *   v2 (capability-gated): /api/sessions, /api/plan, /api/agents, /api/tokens,
 *     /api/queue — addressed with `?run=<run-id>`.
 *
 * Auth: `token` (when present) is sent as both `Authorization: Bearer <token>`
 * and `X-Bgsd-Token: <token>`. Loopback bridges are usually tokenless.
 *
 * Every fetch degrades to null on any failure (unreachable, non-2xx, 404 for a
 * missing v2 route, unparseable body) so a v1 bridge that lacks the v2 routes
 * simply yields nulls the projection can synthesize around. The SSE consumer
 * ({@link streamEvents}) resumes from a since-cursor and reconnects with
 * exponential backoff.
 *
 * Zero new npm deps: Effect's HttpClient + a hand-rolled SSE line parser.
 *
 * @module bgsd/bridgeClient
 */
import {
  BgsdHealth,
  BgsdOutboxEvent,
  BgsdPlan,
  BgsdQueue,
  BgsdSessions,
  BgsdTokensSummary,
  BgsdAgent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/** Cap for the reconnect backoff between SSE reconnection attempts. */
export const MAX_RECONNECT_BACKOFF = Duration.seconds(30);

/** Default per-request timeout for the bridge. */
export const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(5);

/**
 * Health `capabilities` keys that gate the v2 routes. A v1 bridge omits the
 * whole `capabilities` map, so absence means "assume the route is missing and
 * synthesize from /api/state".
 */
export const BGSD_CAPABILITY_KEYS = {
  sessions: "sessions",
  plan: "plan",
  agents: "agents",
  tokens: "tokens",
  queue: "queue",
  stream: "stream",
  events: "events",
  state: "state",
} as const;

// ---------------------------------------------------------------------------
// Response schemas for the v1 /api/state and /api/events routes. These are NOT
// in the frozen contract (which types the granular v2 routes); they are the
// raw bridge shapes we normalize from. Kept permissive: unknown keys ignored.
// ---------------------------------------------------------------------------

export const BgsdStateAgentLite = Schema.Struct({
  id: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
});
export type BgsdStateAgentLite = typeof BgsdStateAgentLite.Type;

export const BgsdStateRun = Schema.Struct({
  run_id: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  scale: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  stage: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.optional(Schema.NullOr(Schema.String)),
});
export type BgsdStateRun = typeof BgsdStateRun.Type;

/** Raw shape of `GET /api/state` (v1 bridge). */
export const BgsdStatePayload = Schema.Struct({
  run_id: Schema.optional(Schema.NullOr(Schema.String)),
  run: Schema.optional(BgsdStateRun),
  stage: Schema.optional(Schema.NullOr(Schema.String)),
  stage_label: Schema.optional(Schema.NullOr(Schema.String)),
  counts: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  gate_command: Schema.optional(Schema.NullOr(Schema.String)),
  narration_lines: Schema.optional(Schema.Array(Schema.String)),
  agents: Schema.optional(Schema.Array(BgsdStateAgentLite)),
  pending_questions: Schema.optional(Schema.Array(Schema.Unknown)),
  conductor: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      emoji: Schema.optional(Schema.String),
    }),
  ),
});
export type BgsdStatePayload = typeof BgsdStatePayload.Type;

/** Raw shape of `GET /api/events?since=` (v1 bridge). */
export const BgsdEventsPayload = Schema.Struct({
  run_id: Schema.optional(Schema.NullOr(Schema.String)),
  events: Schema.optional(Schema.Array(BgsdOutboxEvent)),
});
export type BgsdEventsPayload = typeof BgsdEventsPayload.Type;

/** The v2 `/api/agents` route returns `{ agents: [...] }` or a bare array. */
export const BgsdAgentsPayload = Schema.Union([
  Schema.Struct({ agents: Schema.Array(Schema.Unknown) }),
  Schema.Array(Schema.Unknown),
]);

// ---------------------------------------------------------------------------
// SSE parsing (pure — unit-tested in isolation).
// ---------------------------------------------------------------------------

/** One parsed SSE frame from the bridge's `/api/stream`. */
export interface SseFrame {
  /** The `id:` field, if present — the event seq used as the resume cursor. */
  readonly id: string | null;
  /** The joined `data:` payload. */
  readonly data: string;
}

/**
 * A stateful, line-oriented SSE parser. Feed it lines (already split on `\n`,
 * newline stripped) and it emits a frame each time a blank line terminates an
 * event. Comment lines (`:` prefix, e.g. `: ping` keepalive) are ignored.
 *
 * The bridge emits `id: <seq>` then `data: <json>` then a blank line per event.
 */
export class SseLineParser {
  private id: string | null = null;
  private dataLines: string[] = [];

  /** Feed one line. Returns a completed frame on a blank terminator, else null. */
  push(line: string): SseFrame | null {
    // A blank line dispatches the buffered event.
    if (line === "") {
      if (this.dataLines.length === 0 && this.id === null) {
        return null;
      }
      const frame: SseFrame = { id: this.id, data: this.dataLines.join("\n") };
      this.id = null;
      this.dataLines = [];
      return frame;
    }
    // Comment / keepalive line.
    if (line.startsWith(":")) {
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Per the SSE spec, a single leading space after the colon is stripped.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "id") {
      this.id = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    }
    // `event:` / `retry:` fields are ignored — the bridge does not use them.
    return null;
  }
}

const decodeOutboxEventJson = Schema.decodeUnknownExit(Schema.fromJsonString(BgsdOutboxEvent));

/**
 * Decode an SSE frame's `data` into a BgsdOutboxEvent. Returns null when the
 * payload is not a well-formed event (tolerated, not fatal).
 */
export const parseSseFrame = (frame: SseFrame): BgsdOutboxEvent | null => {
  if (frame.data.trim().length === 0) {
    return null;
  }
  const decoded = decodeOutboxEventJson(frame.data);
  return decoded._tag === "Success" ? decoded.value : null;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface BgsdBridgeClientOptions {
  readonly baseUrl: string;
  readonly token?: string | null;
  readonly timeout?: Duration.Duration;
}

const withAuth = (
  request: HttpClientRequest.HttpClientRequest,
  token: string | null | undefined,
): HttpClientRequest.HttpClientRequest =>
  token
    ? request.pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("X-Bgsd-Token", token),
      )
    : request;

/** Build a `?run=<id>` suffix, or empty string when no run is targeted. */
const runQuery = (run: string | null | undefined): string =>
  run ? `?run=${encodeURIComponent(run)}` : "";

export interface BgsdBridgeClient {
  readonly health: Effect.Effect<BgsdHealth | null, never, HttpClient.HttpClient>;
  readonly state: Effect.Effect<BgsdStatePayload | null, never, HttpClient.HttpClient>;
  readonly events: (
    since: number,
  ) => Effect.Effect<BgsdEventsPayload | null, never, HttpClient.HttpClient>;
  readonly sessions: Effect.Effect<BgsdSessions | null, never, HttpClient.HttpClient>;
  readonly plan: (
    run: string | null,
  ) => Effect.Effect<BgsdPlan | null, never, HttpClient.HttpClient>;
  readonly agents: (
    run: string | null,
  ) => Effect.Effect<ReadonlyArray<BgsdAgent> | null, never, HttpClient.HttpClient>;
  readonly tokens: (
    run: string | null,
  ) => Effect.Effect<BgsdTokensSummary | null, never, HttpClient.HttpClient>;
  readonly queue: Effect.Effect<BgsdQueue | null, never, HttpClient.HttpClient>;
  /**
   * SSE stream of outbox events from `since` onward, with exponential-backoff
   * reconnect. Malformed frames are dropped; keepalive comments are ignored.
   */
  readonly streamEvents: (
    since: number,
  ) => Stream.Stream<BgsdOutboxEvent, never, HttpClient.HttpClient>;
}

const decodeHealth = Schema.decodeUnknownExit(BgsdHealth);
const decodeState = Schema.decodeUnknownExit(BgsdStatePayload);
const decodeEvents = Schema.decodeUnknownExit(BgsdEventsPayload);
const decodeSessions = Schema.decodeUnknownExit(BgsdSessions);
const decodePlan = Schema.decodeUnknownExit(BgsdPlan);
const decodeTokens = Schema.decodeUnknownExit(BgsdTokensSummary);
const decodeQueue = Schema.decodeUnknownExit(BgsdQueue);
const decodeAgents = Schema.decodeUnknownExit(BgsdAgentsPayload);
const decodeAgent = Schema.decodeUnknownExit(BgsdAgent);

export const makeBgsdBridgeClient = (options: BgsdBridgeClientOptions): BgsdBridgeClient => {
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeout = options.timeout ?? DEFAULT_REQUEST_TIMEOUT;

  /** GET a route and decode its JSON body, degrading to null on any failure. */
  const fetchDecoded = <A>(
    routePath: string,
    decodeExit: (
      value: unknown,
    ) => { readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure" },
  ): Effect.Effect<A | null, never, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = withAuth(HttpClientRequest.get(`${base}${routePath}`), options.token);
      const body = yield* client.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeoutOption(timeout),
        Effect.orElseSucceed(() => Option.none<unknown>()),
      );
      if (Option.isNone(body)) {
        return null;
      }
      const decoded = decodeExit(body.value);
      return decoded._tag === "Success" ? decoded.value : null;
    });

  const agents = (run: string | null) =>
    fetchDecoded(`/api/agents${runQuery(run)}`, decodeAgents).pipe(
      Effect.map((payload): ReadonlyArray<BgsdAgent> | null => {
        if (payload === null) {
          return null;
        }
        const rawList: ReadonlyArray<unknown> = "agents" in payload ? payload.agents : payload;
        const out: BgsdAgent[] = [];
        for (const entry of rawList) {
          const decoded = decodeAgent(entry);
          if (decoded._tag === "Success") {
            out.push(decoded.value);
          }
        }
        return out;
      }),
    );

  const streamEvents = (
    since: number,
  ): Stream.Stream<BgsdOutboxEvent, never, HttpClient.HttpClient> => {
    // One connection attempt: open /api/stream?since=<cursor>, decode frames.
    // A fresh parser per connection means reconnects never inherit a partial
    // frame from a dropped socket.
    const connect = (cursor: number) => {
      const parser = new SseLineParser();
      const request = withAuth(
        HttpClientRequest.get(`${base}/api/stream?since=${cursor}`),
        options.token,
      );
      const executed = Effect.flatMap(HttpClient.HttpClient, (client) => client.execute(request));
      return HttpClientResponse.stream(executed).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.map((line): BgsdOutboxEvent | null => {
          const frame = parser.push(line);
          return frame === null ? null : parseSseFrame(frame);
        }),
        Stream.filter(Predicate.isNotNull),
      );
    };

    // Reconnect with exponential backoff capped at MAX_RECONNECT_BACKOFF. The
    // Ref-free cursor advance keeps the resume point moving so a reconnect never
    // replays the whole history.
    return Stream.unwrap(
      Effect.sync(() => {
        let cursor = since;
        const backoff = Schedule.exponential(Duration.seconds(1), 2).pipe(
          Schedule.modifyDelay((_output, delay) =>
            Effect.succeed(
              Duration.isLessThan(delay, MAX_RECONNECT_BACKOFF) ? delay : MAX_RECONNECT_BACKOFF,
            ),
          ),
        );
        return Stream.unwrap(Effect.sync(() => connect(cursor))).pipe(
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.seq > cursor) {
                cursor = event.seq;
              }
            }),
          ),
          Stream.retry(backoff),
          // Redirect any residual failure into an empty tail rather than
          // surfacing it to the RPC caller; the periodic re-probe re-establishes.
          Stream.catchCause(() => Stream.empty),
        );
      }),
    );
  };

  return {
    health: fetchDecoded("/api/health", decodeHealth),
    state: fetchDecoded("/api/state", decodeState),
    events: (since: number) => fetchDecoded(`/api/events?since=${since}`, decodeEvents),
    sessions: fetchDecoded("/api/sessions", decodeSessions),
    plan: (run: string | null) => fetchDecoded(`/api/plan${runQuery(run)}`, decodePlan),
    agents,
    tokens: (run: string | null) => fetchDecoded(`/api/tokens${runQuery(run)}`, decodeTokens),
    queue: fetchDecoded("/api/queue", decodeQueue),
    streamEvents,
  } satisfies BgsdBridgeClient;
};

/**
 * Given a health payload, decide whether a v2 capability is present. A v1
 * bridge (no `capabilities` map) reports false for every v2 route.
 */
export const hasCapability = (health: BgsdHealth | null, key: string): boolean => {
  if (!health || !health.capabilities) {
    return false;
  }
  return health.capabilities[key] === true;
};
