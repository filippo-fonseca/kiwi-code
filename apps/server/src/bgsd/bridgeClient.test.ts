import { assert, describe, it } from "@effect/vitest";

import {
  BGSD_CAPABILITY_KEYS,
  hasCapability,
  parseSseFrame,
  SseLineParser,
  type SseFrame,
} from "./bridgeClient.ts";

/** Feed a whole SSE text blob line-by-line, collecting completed frames. */
const drain = (parser: SseLineParser, text: string): SseFrame[] => {
  const frames: SseFrame[] = [];
  for (const line of text.split("\n")) {
    const frame = parser.push(line);
    if (frame !== null) {
      frames.push(frame);
    }
  }
  return frames;
};

describe("bgsd/bridgeClient SSE parser", () => {
  it("parses a single id+data frame terminated by a blank line", () => {
    const parser = new SseLineParser();
    const frames = drain(parser, 'id: 12\ndata: {"seq":12}\n\n');
    assert.deepEqual(frames, [{ id: "12", data: '{"seq":12}' }]);
  });

  it("parses several consecutive frames", () => {
    const parser = new SseLineParser();
    const frames = drain(parser, "id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 3\ndata: c\n\n");
    assert.deepEqual(frames, [
      { id: "1", data: "a" },
      { id: "2", data: "b" },
      { id: "3", data: "c" },
    ]);
  });

  it("ignores comment / keepalive lines", () => {
    const parser = new SseLineParser();
    const frames = drain(parser, ": ping\n\nid: 5\ndata: x\n\n: ping\n\n");
    assert.deepEqual(frames, [{ id: "5", data: "x" }]);
  });

  it("joins multi-line data payloads with newlines", () => {
    const parser = new SseLineParser();
    const frames = drain(parser, "data: line1\ndata: line2\n\n");
    assert.deepEqual(frames, [{ id: null, data: "line1\nline2" }]);
  });

  it("strips exactly one leading space after the colon", () => {
    const parser = new SseLineParser();
    const frames = drain(parser, "data:  two-spaces\n\n");
    // One space stripped, one retained.
    assert.deepEqual(frames, [{ id: null, data: " two-spaces" }]);
  });

  it("does not emit on a stray blank line with no buffered event", () => {
    const parser = new SseLineParser();
    const frames = drain(parser, "\n\n\n");
    assert.deepEqual(frames, []);
  });

  it("holds an incomplete frame until its terminating blank line arrives", () => {
    const parser = new SseLineParser();
    // No trailing blank line yet.
    assert.deepEqual(drain(parser, "id: 9\ndata: partial"), []);
    // The terminator completes the buffered frame.
    assert.deepEqual(parser.push(""), { id: "9", data: "partial" });
  });
});

describe("bgsd/bridgeClient parseSseFrame", () => {
  it("decodes a well-formed outbox event", () => {
    const event = parseSseFrame({
      id: "12",
      data: '{"seq":12,"at":"2026-07-05T18:20:01.004Z","type":"narration","text":"hi"}',
    });
    assert.deepEqual(event, {
      seq: 12,
      at: "2026-07-05T18:20:01.004Z",
      type: "narration",
      text: "hi",
    });
  });

  it("returns null for an empty data payload", () => {
    assert.strictEqual(parseSseFrame({ id: null, data: "" }), null);
  });

  it("returns null for malformed JSON (tolerated, not fatal)", () => {
    assert.strictEqual(parseSseFrame({ id: "1", data: "{not json" }), null);
  });

  it("returns null when the required seq field is missing", () => {
    assert.strictEqual(parseSseFrame({ id: "1", data: '{"type":"narration"}' }), null);
  });
});

describe("bgsd/bridgeClient hasCapability", () => {
  it("is false when health is null (unreachable bridge)", () => {
    assert.strictEqual(hasCapability(null, BGSD_CAPABILITY_KEYS.plan), false);
  });

  it("is false for a v1 bridge that omits the capabilities map", () => {
    assert.strictEqual(hasCapability({ ok: true }, BGSD_CAPABILITY_KEYS.agents), false);
  });

  it("is true only when the capability is explicitly true", () => {
    const health = { ok: true, capabilities: { plan: true, agents: false } };
    assert.strictEqual(hasCapability(health, BGSD_CAPABILITY_KEYS.plan), true);
    assert.strictEqual(hasCapability(health, BGSD_CAPABILITY_KEYS.agents), false);
    assert.strictEqual(hasCapability(health, BGSD_CAPABILITY_KEYS.tokens), false);
  });
});
