import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { RulesResolver } from "./permission-rules.js";

function req(kind: string, title: string): RequestPermissionRequest {
  const toolCall: RequestPermissionRequest["toolCall"] = {
    toolCallId: "t",
    title,
    status: "pending",
  };
  if (kind !== "") {
    toolCall.kind = kind as NonNullable<RequestPermissionRequest["toolCall"]["kind"]>;
  }
  return {
    sessionId: "s",
    toolCall,
    options: [
      { optionId: "y", name: "y", kind: "allow_once" },
      { optionId: "n", name: "n", kind: "reject_once" },
    ],
  };
}

describe("RulesResolver", () => {
  test("allows when toolCall.kind is in allowKinds", async () => {
    const r = new RulesResolver({ allowKinds: ["read", "search"], denyTitleSubstrings: [] });
    const out = await r.resolve(req("read", "Read /etc/hosts"));
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "y" } });
  });

  test("denies when title contains a denied substring (even if kind allowed)", async () => {
    const r = new RulesResolver({ allowKinds: ["execute"], denyTitleSubstrings: ["rm -rf"] });
    const out = await r.resolve(req("execute", "Run rm -rf /"));
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "n" } });
  });

  test("abstains (cancelled) when no rule matches — caller chains to next resolver", async () => {
    const r = new RulesResolver({ allowKinds: ["read"], denyTitleSubstrings: [] });
    const out = await r.resolve(req("execute", "Run curl"));
    expect(out).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
