import { describe, expect, test } from "bun:test";
import { signalAgentTaskDone } from "./agent-task-done.js";

describe("signalAgentTaskDone", () => {
  test("POSTs to /api/agent-tasks/:id/done with bearer auth", async () => {
    type CallRecord = { url: string; init: RequestInit };
    const calls: Array<CallRecord> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const ctx = { taskId: "task-x", generation: 1 };
    const opts = {
      baseUrl: "http://localhost:4515",
      token: "abc123",
      fetchImpl: fakeFetch,
    };
    await signalAgentTaskDone(ctx, "review approved", opts);
    expect(calls).toHaveLength(1);
    const expectedUrl = "http://localhost:4515/api/agent-tasks/task-x/done";
    expect(calls[0]?.url).toBe(expectedUrl);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc123");
    const expectedBody = JSON.stringify({ summary: "review approved" });
    expect(calls[0]?.init.body).toBe(expectedBody);
  });

  test("throws when baseUrl missing", async () => {
    await expect(
      signalAgentTaskDone({ taskId: "x", generation: 1 }, "s", {
        baseUrl: undefined,
        token: "t",
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/GROVE_SERVER_URL/);
  });

  test("throws when token missing", async () => {
    await expect(
      signalAgentTaskDone({ taskId: "x", generation: 1 }, "s", {
        baseUrl: "http://x",
        token: undefined,
        fetchImpl: fetch,
      }),
    ).rejects.toThrow(/GROVE_API_TOKEN/);
  });

  test("throws on non-2xx response", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response("not found", { status: 404 });
    };
    const ctx = { taskId: "x", generation: 1 };
    const opts = { baseUrl: "http://x", token: "t", fetchImpl: fakeFetch };
    await expect(signalAgentTaskDone(ctx, "s", opts)).rejects.toThrow(/404/);
  });

  test("encodes taskId for URL safety", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };
    const ctx = { taskId: "task/with/slashes", generation: 1 };
    const opts = { baseUrl: "http://x", token: "t", fetchImpl: fakeFetch };
    await signalAgentTaskDone(ctx, "s", opts);
    const encoded = "http://x/api/agent-tasks/task%2Fwith%2Fslashes/done";
    expect(calls[0]).toBe(encoded);
  });
});
