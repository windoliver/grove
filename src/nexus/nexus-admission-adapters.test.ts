import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { ContributionKind, ContributionMode } from "../core/models.js";
import {
  createNexusAdmissionAdapters,
  NexusAdmissionGovernanceEvaluator,
  NexusAdmissionPermissionResolver,
} from "./nexus-admission-adapters.js";
import { NexusRpcClient } from "./nexus-rpc-client.js";

const originalFetch = globalThis.fetch;
let fetchCalls: {
  readonly input: Parameters<typeof fetch>[0];
  readonly init: Parameters<typeof fetch>[1];
}[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  fetchCalls = [];
});

function mockFetch(result: unknown, status = 200): void {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchCalls.push({ input, init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
}

function mockFetchSequence(results: readonly unknown[]): void {
  let index = 0;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchCalls.push({ input, init });
      const result = results[index] ?? results.at(-1);
      index += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
}

function lastFetchCall(): (typeof fetchCalls)[number] {
  const call = fetchCalls.at(-1);
  if (call === undefined) {
    throw new Error("expected fetch to be called");
  }
  return call;
}

function requestBody(call: (typeof fetchCalls)[number]): unknown {
  if (typeof call.init?.body !== "string") {
    throw new Error("expected JSON string request body");
  }
  return JSON.parse(call.init.body);
}

function requestHeaders(call: (typeof fetchCalls)[number]): Headers {
  return new Headers(call.init?.headers);
}

function mockFetchError(error: unknown, status = 200): void {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchCalls.push({ input, init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
}

function mockHttpError(status: number): void {
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      fetchCalls.push({ input, init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
}

describe("NexusRpcClient", () => {
  test("throws on JSON-RPC error envelopes", async () => {
    mockFetchError({ code: -32_000, message: "boom" });
    const client = new NexusRpcClient({ url: "http://nexus.test" });

    await expect(client.call("rebac_check", {}, z.boolean())).rejects.toThrow(
      "Nexus RPC rebac_check failed",
    );
  });

  test("throws on HTTP errors", async () => {
    mockHttpError(503);
    const client = new NexusRpcClient({ url: "http://nexus.test" });

    await expect(client.call("rebac_check", {}, z.boolean())).rejects.toThrow(
      "Nexus RPC rebac_check failed: HTTP 503",
    );
  });
});

describe("createNexusAdmissionAdapters", () => {
  test("creates ReBAC and governance delegates from Nexus RPC config", async () => {
    mockFetchSequence([
      true,
      { recent_alerts: { alerts: [], count: 0 }, fraud_rings: { rings: [], count: 0 } },
    ]);
    const adapters = createNexusAdmissionAdapters({
      url: "http://nexus.test/",
      apiKey: "key",
    });

    await adapters.admissionPermissionResolver.check({
      subjectType: "agent",
      subjectId: "agent-1",
      permission: "contribute",
      objectType: "session",
      objectId: "session-1",
      zoneId: "zone-1",
    });
    await adapters.admissionGovernanceEvaluator.evaluate({
      policy: "governance_status_clean",
      agentId: "agent-1",
      contribution: {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "work",
        artifacts: {},
        relations: [],
        tags: [],
        agent: { agentId: "agent-1" },
        createdAt: "2026-05-27T00:00:00.000Z",
      },
      zoneId: "zone-1",
    });

    expect(fetchCalls.map((call) => call.input)).toEqual([
      "http://nexus.test/api/nfs/rebac_check",
      "http://nexus.test/api/nfs/governance_status",
    ]);
    const rebacCall = fetchCalls[0];
    const governanceCall = fetchCalls[1];
    if (rebacCall === undefined || governanceCall === undefined) {
      throw new Error("expected ReBAC and governance RPC calls");
    }
    expect(requestHeaders(rebacCall).get("authorization")).toBe("Bearer key");
    expect(requestHeaders(governanceCall).get("authorization")).toBe("Bearer key");
  });
});

describe("NexusAdmissionPermissionResolver", () => {
  test("maps allowed rebac_check result", async () => {
    mockFetch(true);
    const resolver = new NexusAdmissionPermissionResolver(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "key" }),
    );

    const decision = await resolver.check({
      subjectType: "agent",
      subjectId: "agent-1",
      permission: "review",
      objectType: "contribution",
      objectId: "cid-1",
      zoneId: "zone-1",
    });

    expect(decision).toEqual({
      allowed: true,
      evidence: { backend: "nexus", method: "rebac_check" },
    });
    const call = lastFetchCall();
    expect(call.input).toBe("http://nexus.test/api/nfs/rebac_check");
    expect(requestHeaders(call).get("content-type")).toBe("application/json");
    expect(requestHeaders(call).get("authorization")).toBe("Bearer key");
    expect(requestBody(call)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "rebac_check",
      params: {
        subject: ["agent", "agent-1"],
        permission: "review",
        object: ["contribution", "cid-1"],
        zone_id: "zone-1",
      },
    });
  });

  test("maps denied rebac_check result", async () => {
    mockFetch(false);
    const resolver = new NexusAdmissionPermissionResolver(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "key" }),
    );

    const decision = await resolver.check({
      subjectType: "agent",
      subjectId: "agent-1",
      permission: "review",
      objectType: "contribution",
      objectId: "cid-1",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("Nexus ReBAC denied permission");
  });

  test("omits authorization header when API key is empty", async () => {
    mockFetch(true);
    const resolver = new NexusAdmissionPermissionResolver(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "" }),
    );

    await resolver.check({
      subjectType: "agent",
      subjectId: "agent-1",
      permission: "review",
      objectType: "contribution",
      objectId: "cid-1",
    });

    expect(requestHeaders(lastFetchCall()).get("authorization")).toBeNull();
  });
});

describe("NexusAdmissionGovernanceEvaluator", () => {
  test("accepts clean governance status", async () => {
    mockFetch({ recent_alerts: { alerts: [], count: 0 }, fraud_rings: { rings: [], count: 0 } });
    const evaluator = new NexusAdmissionGovernanceEvaluator(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "key" }),
    );

    const decision = await evaluator.evaluate({
      policy: "governance_status_clean",
      agentId: "agent-1",
      contribution: {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "work",
        artifacts: {},
        relations: [],
        tags: [],
        agent: { agentId: "agent-1" },
        createdAt: "2026-05-27T00:00:00.000Z",
      },
    });

    expect(decision.allowed).toBe(true);
    expect(lastFetchCall().input).toBe("http://nexus.test/api/nfs/governance_status");
    expect(requestBody(lastFetchCall())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "governance_status",
      params: {},
    });
  });

  test("rejects governance status with alerts", async () => {
    mockFetch({
      recent_alerts: { alerts: [{ agent_id: "agent-1", severity: "high" }], count: 1 },
      fraud_rings: { rings: [], count: 0 },
    });
    const evaluator = new NexusAdmissionGovernanceEvaluator(
      new NexusRpcClient({ url: "http://nexus.test", apiKey: "key" }),
    );

    const decision = await evaluator.evaluate({
      policy: "governance_status_clean",
      agentId: "agent-1",
      contribution: {
        kind: ContributionKind.Work,
        mode: ContributionMode.Evaluation,
        summary: "work",
        artifacts: {},
        relations: [],
        tags: [],
        agent: { agentId: "agent-1" },
        createdAt: "2026-05-27T00:00:00.000Z",
      },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("Nexus governance status is not clean");
  });
});
