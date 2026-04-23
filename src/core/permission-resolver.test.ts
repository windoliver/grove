import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AuditingResolver, ChainResolver, DENY_ALL_RESOLVER } from "./permission-resolver.js";

function req(overrides: Partial<RequestPermissionRequest> = {}): RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: {
      toolCallId: "tc-1",
      title: "Run rm -rf /",
      kind: "execute",
      status: "pending",
    },
    options: [
      { optionId: "ok", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Deny", kind: "reject_once" },
    ],
    ...overrides,
  };
}

describe("DENY_ALL_RESOLVER", () => {
  test("selects the first reject_* option when available", async () => {
    const r = await DENY_ALL_RESOLVER.resolve(req());
    expect(r).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });

  test("falls back to cancelled when no reject option", async () => {
    const r = await DENY_ALL_RESOLVER.resolve(
      req({ options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] }),
    );
    expect(r).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("prefers reject_once over reject_always", async () => {
    const r = await DENY_ALL_RESOLVER.resolve(
      req({
        options: [
          { optionId: "forever", name: "Deny always", kind: "reject_always" },
          { optionId: "once", name: "Deny once", kind: "reject_once" },
        ],
      }),
    );
    expect(r).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
  });
});

describe("ChainResolver", () => {
  test("first resolver that returns 'selected' wins; others skipped", async () => {
    const calls: string[] = [];
    const chain = new ChainResolver([
      {
        async resolve() {
          calls.push("a");
          return { outcome: { outcome: "cancelled" } };
        },
      },
      {
        async resolve() {
          calls.push("b");
          return { outcome: { outcome: "selected", optionId: "ok" } };
        },
      },
      {
        async resolve() {
          calls.push("c");
          return { outcome: { outcome: "selected", optionId: "no" } };
        },
      },
    ]);
    const out = await chain.resolve(req());
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "ok" } });
    expect(calls).toEqual(["a", "b"]);
  });

  test("all resolvers abstain → DENY_ALL fallback", async () => {
    const chain = new ChainResolver([
      {
        async resolve() {
          return { outcome: { outcome: "cancelled" } };
        },
      },
    ]);
    const out = await chain.resolve(req());
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });
});

describe("AuditingResolver", () => {
  test("writes a JSONL entry per request and returns inner response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const logPath = join(dir, "perm.jsonl");
    const inner: import("./permission-resolver.js").PermissionResolver = {
      async resolve() {
        return { outcome: { outcome: "selected", optionId: "ok" } };
      },
    };
    const audited = new AuditingResolver(inner, logPath);
    const response = await audited.resolve(req());
    expect(response.outcome).toEqual({ outcome: "selected", optionId: "ok" });

    const line = readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(line) as {
      ts: string;
      sessionId: string;
      toolCall: { title: string };
      response: { outcome: { optionId: string } };
    };
    expect(entry.sessionId).toBe("sess-1");
    expect(entry.toolCall.title).toBe("Run rm -rf /");
    expect(entry.response.outcome.optionId).toBe("ok");
  });
});
