import { expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";
import { AcpxTurnImpl, classifyMessage } from "./turn.js";
import type { Message } from "./types.js";

function makeStream(lines: string[]): Readable {
  return Readable.from([`${lines.join("\n")}\n`]);
}

/**
 * Emit the trusted session/new request/response pair that binds AcpParser
 * to the given wire sessionId. Real acpx stdout echoes BOTH its outbound
 * `session/new` request and the agent's response, and AcpParser correlates
 * the response's id back to the tracked request id to accept the binding.
 * Tests simulating turn streams must include the pair so subsequent
 * `session/update` frames are not quarantined as `_sessionUnbound` (issue
 * #319 adversarial review round 3).
 */
function handshake(wireSessionId: string, id: string | number = 0): string[] {
  return [
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [] },
    }),
    JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId: wireSessionId } }),
  ];
}

test("AcpxTurn yields messages and resolves result from a stream", async () => {
  const lines = [
    ...handshake("s1"),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: makeStream(lines),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;
  // handshake → 2 raw (session/new request + _result response),
  // session/update → text. 3 messages total.
  expect(got).toHaveLength(3);
  const texts = got.filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text");
  expect(texts).toHaveLength(1);
  expect(texts[0]?.text).toBe("hi");
  expect(r.stopReason).toBe("end_turn");
});

test("cancel() calls cancelFn", async () => {
  let cancelCalled = false;
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "cancelled" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: makeStream(lines),
    cancelFn: async () => {
      cancelCalled = true;
    },
  });
  await turn.cancel();
  for await (const _ of turn.messages) {
    /* drain */
  }
  const r = await turn.result;
  expect(cancelCalled).toBe(true);
  expect(r.stopReason).toBe("cancelled");
});

test("cancel() remains callable after a successful write — provider may not honor it", async () => {
  // A successful cancelFn write only means "cancel requested", not confirmed.
  // Callers can re-invoke cancel() to re-send until the turn's result settles.
  let calls = 0;
  const stdout = new PassThrough();
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout,
    cancelFn: async () => {
      calls += 1;
    },
  });
  const drain = (async () => {
    for await (const _ of turn.messages) {
      /* noop */
    }
  })();
  await turn.cancel();
  expect(calls).toBe(1);
  // Turn hasn't settled → next cancel re-sends.
  await turn.cancel();
  expect(calls).toBe(2);
  stdout.end();
  await drain;
  await turn.result;
});

test("cancel() is retryable: failed cancelFn leaves the turn cancellable", async () => {
  let attempts = 0;
  const stdout = new PassThrough();
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout,
    cancelFn: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient IPC failure");
      }
    },
  });
  const drain = (async () => {
    for await (const _ of turn.messages) {
      /* noop */
    }
  })();
  await expect(turn.cancel()).rejects.toThrow("transient IPC failure");
  // The first attempt threw — a retry must still invoke cancelFn.
  await turn.cancel();
  expect(attempts).toBe(2);
  // Another explicit re-send escalation while the turn is still in flight.
  await turn.cancel();
  expect(attempts).toBe(3);
  stdout.end();
  await drain;
  await turn.result;
});

test("cancel() is single-flight under concurrent callers", async () => {
  let calls = 0;
  const stdout = new PassThrough();
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout,
    cancelFn: async () => {
      calls += 1;
      // Simulate slow transport so concurrent callers race into the same attempt.
      await new Promise((r) => setTimeout(r, 20));
    },
  });
  const drain = (async () => {
    for await (const _ of turn.messages) {
      /* noop */
    }
  })();
  // Fire 3 callers simultaneously; only one underlying cancelFn invocation is allowed.
  await Promise.all([turn.cancel(), turn.cancel(), turn.cancel()]);
  expect(calls).toBe(1);
  stdout.end();
  await drain;
  await turn.result;
});

test("cancel() short-circuits once the turn's result has settled", async () => {
  let calls = 0;
  const lines = [JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } })];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => {
      calls += 1;
    },
  });
  // Drain to completion so resultSettled flips.
  for await (const _ of turn.messages) {
    /* drain */
  }
  await turn.result;
  // Allow the result.then handler to flush.
  await new Promise((r) => setImmediate(r));
  await turn.cancel();
  expect(calls).toBe(0);
});

test("cancel() same-tick after result resolution is a no-op (no microtask race)", async () => {
  // If settlement is tracked only via a .then() latch on `this.result`, a
  // caller that invokes cancel() in the same tick as the result resolution
  // will still see the latch as false and spuriously fire cancelFn. This
  // test forces that race by awaiting result and immediately cancelling —
  // without any setImmediate/setTimeout flush in between.
  let calls = 0;
  const lines = [JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } })];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => {
      calls += 1;
    },
  });
  for await (const _ of turn.messages) {
    /* drain */
  }
  await turn.result;
  // NO microtask flush here — cancel() must observe settlement synchronously.
  await turn.cancel();
  expect(calls).toBe(0);
});

test("EOF without result yields acpx_exit error Result", async () => {
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([""]),
    cancelFn: async () => undefined,
  });
  for await (const _ of turn.messages) {
    /* drain */
  }
  const r = await turn.result;
  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("acpx_exit");
});

test("AcpxTurnImpl: default capacity 256 evicts oldest under slow consumer", async () => {
  // 300 raw events + terminal result. Slow consumer yields between reads so
  // the pump can fill the channel buffer, exercising drop_oldest_on_full
  // eviction (raw → drop_oldest_on_full policy).
  const N = 300;
  const lines: string[] = [...handshake("s1")];
  for (let i = 0; i < N; i++) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "_unknown_kind", n: i } },
      }),
    );
  }
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: "req-1", result: { stopReason: "end_turn" } }));

  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });

  // Slow consumer: yield to the event loop between reads so the pump runs
  // ahead and the buffer reaches its 256 cap, forcing eviction of the oldest
  // raw events.
  const got: Message[] = [];
  for await (const m of turn.messages) {
    got.push(m);
    await new Promise((r) => setImmediate(r));
  }
  await turn.result;

  // Cannot assert exact count (depends on scheduling), but the buffer cap is
  // 256, so we MUST observe fewer than N=300 messages — eviction fired.
  expect(got.length).toBeLessThan(N);
  expect(got.length).toBeGreaterThan(0);
  // All received messages should be `raw` kind (no terminal frame goes
  // through `messages` — it lands in `result`).
  for (const m of got) expect(m.kind).toBe("raw");
});

test("AcpxTurnImpl: channelCapacity Infinity bypasses eviction", async () => {
  const N = 1000;
  const lines: string[] = [...handshake("s1")];
  for (let i = 0; i < N; i++) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1", update: { sessionUpdate: "_unknown_kind", n: i } },
      }),
    );
  }
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));

  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
    channelCapacity: Infinity,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  await turn.result;
  // N session/update frames + 2 handshake raw frames (session/new + _result).
  expect(got.length).toBe(N + 2);
  // All session/update frames land as raw (unknown sessionUpdate kind).
  const rawUnknown = got.filter((m) => m.kind === "raw" && m.acpMethod === "_unknown_kind");
  expect(rawUnknown).toHaveLength(N);
});

test("classifyMessage covers all Message kinds with expected policies", () => {
  expect(classifyMessage({ kind: "tool_call", turnId: "t", toolCall: { id: "x" } })).toBe("never");
  expect(
    classifyMessage({
      kind: "permission_request",
      turnId: "t",
      request: { id: "x", tool: "y", input: {} },
    }),
  ).toBe("never");
  expect(classifyMessage({ kind: "text", turnId: "t", text: "x", chunk: true })).toBe(
    "coalesce_text_deltas",
  );
  expect(classifyMessage({ kind: "text", turnId: "t", text: "x", chunk: false })).toBe("never");
  expect(classifyMessage({ kind: "thinking", turnId: "t", text: "x", chunk: true })).toBe(
    "coalesce_text_deltas",
  );
  expect(classifyMessage({ kind: "thinking", turnId: "t", text: "x", chunk: false })).toBe("never");
  expect(
    classifyMessage({
      kind: "token_usage",
      turnId: "t",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  ).toBe("drop_oldest_on_full");
  expect(classifyMessage({ kind: "raw", turnId: "t", acpMethod: "any", params: {} })).toBe(
    "drop_oldest_on_full",
  );
});

test("REGRESSION: tool_call invalidates text/thinking coalesce tail (#274 round 4)", async () => {
  // Stream: text chunk A → tool_call → text chunk B. Without the boundary
  // invalidation, B coalesces into A's slot which lives BEFORE tool_call in
  // the ring, reordering the visible stream to [text(AB), tool_call] instead
  // of the correct [text(A), tool_call, text(B)]. A slow consumer keeps the
  // events buffered long enough for B to merge into A.
  const lines = [
    ...handshake("s1"),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A" } },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "do work" },
      },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B" } },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) {
    got.push(m);
    // Slow consumer: hold every event for one tick so the pump pushes all
    // three before the consumer has drained even one — the only condition
    // under which the reorder bug surfaces.
    await new Promise((r) => setImmediate(r));
  }
  await turn.result;
  // Skip the leading handshake raw frames (session/new request + _result
  // response) when asserting chronology.
  const kinds = got
    .filter(
      (m) => !(m.kind === "raw" && (m.acpMethod === "_result" || m.acpMethod === "session/new")),
    )
    .map((m) => m.kind);
  // Order must reflect chronology: text, tool_call, text — never [text, text, tool_call]
  // and never [text("AB"), tool_call] (which would mean B merged into A).
  expect(kinds).toEqual(["text", "tool_call", "text"]);
  const texts = got
    .filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text")
    .map((m) => m.text);
  expect(texts).toEqual(["A", "B"]);
});

test("AcpxTurnImpl: chunked text deltas coalesce under default capacity", async () => {
  const lines: string[] = [...handshake("s1")];
  for (let i = 0; i < 50; i++) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } },
        },
      }),
    );
  }
  lines.push(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));

  const turn = new AcpxTurnImpl({
    sessionId: "s1",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
    channelCapacity: 4,
  });

  const got: Message[] = [];
  for await (const m of turn.messages) {
    got.push(m);
    await new Promise((r) => setImmediate(r));
  }
  await turn.result;

  // With cap=4 and a slow consumer, chunked text deltas must coalesce. The
  // exact buffered count depends on scheduling, but the concatenated text
  // must total exactly 50 characters (no character loss) — coalescing
  // preserves text by appending, never dropping.
  expect(got.length).toBeLessThanOrEqual(50); // not stricter — could be 1..50 depending on timing
  const totalText = got
    .filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text")
    .map((m) => m.text)
    .join("");
  expect(totalText.length).toBe(50);
  expect(totalText).toBe("x".repeat(50));
});

// Regression: issue #319 — acpx emits its own internal session UUID in
// session/update frames, not the grove sessionName that the runtime used
// to label the turn. If AcpxTurnImpl forwarded its caller-supplied sessionId
// to AcpParser for filtering, every frame would be demoted to
// _sessionMismatch and consumers would see 0 chars of text.
test("AcpxTurn does not filter frames by caller-supplied sessionId (issue #319)", async () => {
  const lines = [
    // Real acpx precedes session/update with a session/new result carrying
    // its internal UUID. AcpParser binds to that trusted sessionId — not to
    // the caller-supplied grove label — so the session/update that follows
    // is accepted even though its sessionId differs from the grove label.
    ...handshake("acpx-internal-uuid-abc123"),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-internal-uuid-abc123",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    // Grove-style label the runtime hands in — NOT what acpx echoes on the wire.
    sessionId: "grove-reviewer-1--ab12",
    turnId: "t1",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;
  expect(r.stopReason).toBe("end_turn");
  const texts = got.filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text");
  expect(texts).toHaveLength(1);
  expect(texts[0]?.text).toBe("hello");
  const mismatches = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionMismatch");
  expect(mismatches).toHaveLength(0);
});

// Regression: a mixed stream (two wire sessionIds on the same stdout) MUST
// still surface foreign frames as `_sessionMismatch` anomalies. The #319 fix
// removed caller-supplied session filtering; this test locks in that the
// parser auto-learns the first wire sessionId and enforces it on later
// frames, so cross-session contamination is visible in the audit log
// (`rawAnomalyFrames` after compaction).
test("AcpxTurn binds to trusted session/new sessionId and demotes foreign frames (issue #319 audit)", async () => {
  const lines = [
    // Trusted binding: acpx's session/new result carries the real wire id.
    ...handshake("acpx-A"),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-A",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "native" },
        },
      },
    }),
    // Second frame: a foreign session sneaks in — must be demoted.
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-B-foreign",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "LEAK" },
        },
      },
    }),
    // Third frame: native again — should still pass after the foreign leak.
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-A",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: " ok" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    turnId: "t-mix",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  await turn.result;

  // Native text from the learned session survives (possibly coalesced).
  const texts = got.filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text");
  const totalText = texts.map((m) => m.text).join("");
  expect(totalText).toBe("native ok");
  expect(totalText).not.toContain("LEAK");

  // Foreign frame is surfaced as a raw anomaly, not dropped silently.
  const mismatches = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionMismatch");
  expect(mismatches).toHaveLength(1);
  // The anomaly frame retains the foreign params for auditability.
  const mismatch = mismatches[0];
  if (mismatch?.kind !== "raw") throw new Error("unreachable");
  const params = mismatch.params as { sessionId?: string } | undefined;
  expect(params?.sessionId).toBe("acpx-B-foreign");
});

// Adversarial regression (issue #319 round 2): a stream whose FIRST frame is
// a foreign `session/update` — no trusted binding yet — must NOT trust that
// frame to bootstrap the session. It is quarantined as `_sessionUnbound` so
// a later legitimate session/new handshake can still establish the correct
// binding for subsequent traffic.
test("AcpxTurn quarantines session/update arriving before any trust anchor and fails closed", async () => {
  const lines = [
    // Attacker / misbehaving acpx: first wire frame is a session/update
    // that a naive auto-learn would bind to.
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "foreign-poison",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "POISON" },
        },
      },
    }),
    // Then the real trusted session/new handshake lands.
    ...handshake("acpx-real"),
    // A legitimate frame from the real session.
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-real",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "legit" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    turnId: "t-poison",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  // The poisoned first frame must NOT appear as semantic text.
  const poisoned = got
    .filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text")
    .some((m) => m.text.includes("POISON"));
  expect(poisoned).toBe(false);

  // Foreign update surfaces as _sessionUnbound anomaly.
  const unbound = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionUnbound");
  expect(unbound).toHaveLength(1);

  // Round-4 hardening: even though a legitimate handshake arrived later
  // and legitimate updates flowed, the turn MUST fail closed because
  // pre-bind quarantine means early content (if any) was irrecoverably
  // lost from the semantic stream.
  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("session_unbound");
});

// Adversarial regression (issue #319 round 2): a pre-binding session/update
// whose params.sessionId is missing or non-string (schema drift / deliberate
// field stripping) must NOT slip through as semantic content. Quarantine it.
test("AcpxTurn quarantines pre-binding session/update with missing sessionId and fails closed", async () => {
  const lines = [
    // No sessionId on params at all — schema drift.
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "NO_SID" },
        },
      },
    }),
    ...handshake("acpx-real"),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    turnId: "t-drift",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  const texts = got.filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text");
  expect(texts).toHaveLength(0);
  const unbound = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionUnbound");
  expect(unbound).toHaveLength(1);
  // Fail closed (round 4): any pre-bind quarantine invalidates the turn.
  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("session_unbound");
});

// Adversarial regression (issue #319 round 3): a foreign `result.sessionId`
// frame that does NOT correlate to a tracked session/new / session/load
// request id must NOT bind the parser. Otherwise an attacker / buggy
// upstream could poison the binding from any `result` frame.
test("AcpxTurn ignores uncorrelated result.sessionId frames (no poisoning)", async () => {
  const lines = [
    // No session/new request seen yet — this result frame is uncorrelated
    // even though it carries a sessionId. Must NOT bind.
    JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      result: { sessionId: "poisoned-session" },
    }),
    // A session/update for the poisoned id would be accepted IF the poison
    // had bound. Instead it should be `_sessionUnbound`.
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "poisoned-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "POISON" },
        },
      },
    }),
    // Now the real correlated handshake lands.
    ...handshake("acpx-real"),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-real",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "legit" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    turnId: "t-poison-result",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  const poisoned = got
    .filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text")
    .some((m) => m.text.includes("POISON"));
  expect(poisoned).toBe(false);
  const unbound = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionUnbound");
  expect(unbound).toHaveLength(1);
  // Fail closed: pre-bind quarantine marks the turn as lossy.
  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("session_unbound");
});

// Adversarial regression (issue #319 round 3): if the stream carries
// session/update frames but never emits a correlated session/new result,
// the parser quarantines every update AND fails the turn closed. Returning
// `stopReason: "end_turn"` here would hide the fact that 0 semantic
// messages were delivered.
test("AcpxTurn fails closed with session_unbound when no handshake arrives", async () => {
  const lines = [
    // No session/new request + no correlated response — only updates.
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "orphan",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "lost" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    turnId: "t-orphan",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  // Hard failure signal, not a silent empty success.
  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("session_unbound");
  // No semantic text leaked.
  const texts = got.filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text");
  expect(texts).toHaveLength(0);
  const unbound = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionUnbound");
  expect(unbound).toHaveLength(1);
});

// Adversarial regression (issue #319 round 4): a foreign correlated
// handshake (request + response pair with an attacker-chosen id) arrives
// BEFORE the real one. The parser binds to the foreign sessionId; when the
// real handshake follows with a different sessionId, that disagreement
// must be caught and the turn must fail closed with `session_ambiguous` —
// a silent `end_turn` here would paper over cross-session contamination.
test("AcpxTurn fails closed on ambiguous binding (foreign handshake first)", async () => {
  const lines = [
    // Foreign correlated handshake — attacker owns id=99.
    ...handshake("foreign-poison", 99),
    // Real correlated handshake — different id, different sessionId.
    ...handshake("acpx-real", 2),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-real",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "legit" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    turnId: "t-ambiguous",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  // Turn MUST NOT silently end_turn — ambiguity is observable.
  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("session_ambiguous");
  // (Best-effort audit: the mismatched-session traffic is visible as
  // `_sessionMismatch` raw entries since the bound session was "foreign-
  // poison" but the real update used "acpx-real". We do not assert a
  // specific count — the key signal is the terminal failure.)
  const mismatches = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionMismatch");
  expect(mismatches.length).toBeGreaterThan(0);
});

// Adversarial regression (issue #319 round 5): a post-bind conflicting
// `result.sessionId` that LACKS an echoed request frame must still trigger
// ambiguity detection. Restricting ambiguity to correlated responses leaves
// a bypass under schema drift / partial streams / providers that suppress
// the request echo — the turn would resolve `end_turn` while legitimate
// updates were silently demoted to `_sessionMismatch`.
test("AcpxTurn flags ambiguity on uncorrelated conflicting session-response", async () => {
  const lines = [
    // Foreign correlated handshake binds first.
    ...handshake("foreign-poison", 99),
    // Real session-response arrives WITHOUT its request echo — this is
    // the bypass scenario. It disagrees with the current binding.
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "acpx-real" },
    }),
    // Real update for the real session — gets demoted to _sessionMismatch
    // because the parser is still bound to "foreign-poison".
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-real",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "legit" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    turnId: "t-ambig-uncorr",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  expect(r.stopReason).toBe("error");
  expect(r.error?.code).toBe("session_ambiguous");
  const mismatches = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionMismatch");
  expect(mismatches.length).toBeGreaterThan(0);
});

// Multi-turn regression (issue #319 live TUI validation): one acpx child
// serves many turns; only the FIRST turn sees `session/new` on stdout.
// Subsequent turns see only `session/prompt` + `session/update` — no
// handshake. They must be hard-bound by the caller with the learned wire
// sessionId, or the parser's fail-closed path triggers every turn after
// the first. This test simulates turn 2 and asserts a clean end_turn when
// constructed with `wireSessionId`.
test("AcpxTurn hard-binds via wireSessionId for turns without handshake (multi-turn)", async () => {
  const lines = [
    // No session/new — this is turn 2+ on the same acpx child.
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-reused",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "followup" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    wireSessionId: "acpx-reused", // caller knows the id from turn 1
    turnId: "t-2",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  // Hard-bound: no fail-closed, normal end_turn.
  expect(r.stopReason).toBe("end_turn");
  const texts = got.filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text");
  expect(texts.map((m) => m.text).join("")).toBe("followup");
  // Zero pre-bind quarantine anomalies — the parser was bound from frame 1.
  const unbound = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionUnbound");
  expect(unbound).toHaveLength(0);
  // And the getter surfaces the bound id for AcpxRuntime to forward.
  expect(turn.wireSessionId).toBe("acpx-reused");
});

// Round-5 regression: JSON-RPC id type skew (`0` vs `"0"`) between request
// and response MUST still correlate — providers/intermediaries can normalize
// numeric ids to strings (or vice versa) and strict equality would leave
// the parser unbound under benign drift.
test("AcpxTurn correlates session handshake across id numeric/string skew", async () => {
  const lines = [
    // Request uses numeric id 0.
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [] },
    }),
    // Response uses string id "0" — skewed but logically the same id.
    JSON.stringify({ jsonrpc: "2.0", id: "0", result: { sessionId: "acpx-skew" } }),
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "acpx-skew",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "ok" },
        },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }),
  ];
  const turn = new AcpxTurnImpl({
    sessionId: "grove-coder-1--xyz",
    turnId: "t-id-skew",
    stdout: Readable.from([`${lines.join("\n")}\n`]),
    cancelFn: async () => undefined,
  });
  const got: Message[] = [];
  for await (const m of turn.messages) got.push(m);
  const r = await turn.result;

  // Binding succeeded despite id-type skew → normal success, no fail-closed.
  expect(r.stopReason).toBe("end_turn");
  const totalText = got
    .filter((m): m is Extract<Message, { kind: "text" }> => m.kind === "text")
    .map((m) => m.text)
    .join("");
  expect(totalText).toBe("ok");
  const unbound = got.filter((m) => m.kind === "raw" && m.acpMethod === "_sessionUnbound");
  expect(unbound).toHaveLength(0);
});
