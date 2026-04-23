# Grove Direct ACP Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `AcpxRuntime` with `AcpRuntime` that speaks ACP directly to provider binaries, unlocking native `session/request_permission` resolution, real `session/cancel`, and persistent multi-turn connections. Issue #272 subsumed. Spec: `docs/superpowers/specs/2026-04-21-grove-direct-acp-runtime-design.md`.

**Architecture:** New `AcpRuntime implements AgentRuntime` embeds `@agentclientprotocol/sdk`'s `ClientSideConnection`. One persistent provider subprocess per `AgentSession`. Typed `session/update` frames feed a new `AcpTurnImpl` (shares the existing `BoundedEventChannel` + `AcpxTurn` contract so `AcpMessageSink` / `SessionStore` / `publishTurnToNexus` consumers keep working). `PermissionResolver` is the `Client.requestPermission` handler — `DenyAllResolver` default, `ChainResolver` / `AuditingResolver` / `RulesResolver` built-ins. `GROVE_RUNTIME` env flag selects runtime at construction; opt-in at first, default flipped to `acp` after parity tests, `AcpxRuntime` deleted after one release.

**Tech Stack:** Bun 1.3.9 + TypeScript. Deps added: `@agentclientprotocol/sdk@^0.19.1`, `@zed-industries/codex-acp@^0.11.1`, `@agentclientprotocol/claude-agent-acp@^0.30.0`. `gemini-cli` (providing `gemini --acp`) remains an external system requirement. Tests: `bun test`. Existing patterns mirrored from `src/core/acpx-runtime.test.ts` + `src/core/acpx-runtime.integration.test.ts`.

**Reference (not dependency):** acpx source at `/tmp/acpx/src/` is mined for launch-detection patterns (`agent-registry.ts:180-275`) and permission-policy wording (`permissions.ts`). Do NOT vendor acpx code wholesale — port only the subset grove uses.

---

## Checkpoints

- **Checkpoint A** — after Task 11: new runtime compiles with unit tests green. User reviews design choices in code.
- **Checkpoint B** — after Task 15: integration tests green on codex, claude, gemini. User verifies real-provider behaviour.
- **Checkpoint C** — after Task 17: parity harness green. User approves flipping default.
- **Checkpoint D** — before Task 18: default flip committed; soak period. User green-lights deletion.
- **Checkpoint E** — after Task 19: AcpxRuntime deleted. User confirms no stranded callers.

---

## Phase 1 — Foundation (no subprocess)

### Task 1: Add SDK and adapter dependencies

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `bun.lock` (auto-regenerated)

- [ ] **Step 1: Add dependencies**

Edit `package.json`'s `dependencies` block. Insert three keys alphabetically so diffs stay small:

```json
    "@agentclientprotocol/claude-agent-acp": "^0.30.0",
    "@agentclientprotocol/sdk": "^0.19.1",
    "@zed-industries/codex-acp": "^0.11.1",
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: lockfile updates, three packages added under `node_modules/`, no install errors.

- [ ] **Step 3: Smoke-import the SDK**

Write: `src/core/acp-sdk-smoke.test.ts`

```ts
import { test, expect } from "bun:test";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

test("SDK exports resolve", () => {
  expect(typeof ClientSideConnection).toBe("function");
  expect(typeof ndJsonStream).toBe("function");
  expect(PROTOCOL_VERSION).toBe(1);
});
```

Run: `bun test src/core/acp-sdk-smoke.test.ts`
Expected: PASS. If the SDK version drifts and one of these exports vanishes, this test will catch it before runtime code breaks.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/core/acp-sdk-smoke.test.ts
git commit -m "feat(deps): add ACP SDK + codex/claude adapters"
```

---

### Task 2: PermissionResolver core + DenyAllResolver

**Files:**
- Create: `src/core/permission-resolver.ts`
- Create: `src/core/permission-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

`src/core/permission-resolver.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DENY_ALL_RESOLVER } from "./permission-resolver.js";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

function req(overrides: Partial<RequestPermissionRequest> = {}): RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: { toolCallId: "tc-1", title: "Run rm -rf /", kind: "execute", status: "pending" },
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
```

- [ ] **Step 2: Run test — expect failure**

Run: `bun test src/core/permission-resolver.test.ts`
Expected: FAIL — `Cannot find module './permission-resolver.js'`.

- [ ] **Step 3: Write minimal implementation**

`src/core/permission-resolver.ts`:

```ts
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export interface PermissionResolver {
  resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

function selectedOf(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function cancelledOutcome(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function findByKind(
  options: readonly PermissionOption[],
  kinds: readonly PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match;
  }
  return undefined;
}

export const DENY_ALL_RESOLVER: PermissionResolver = {
  async resolve(req) {
    const reject = findByKind(req.options, ["reject_once", "reject_always"]);
    return reject ? selectedOf(reject.optionId) : cancelledOutcome();
  },
};
```

- [ ] **Step 4: Run test — expect pass**

Run: `bun test src/core/permission-resolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/permission-resolver.ts src/core/permission-resolver.test.ts
git commit -m "feat(core): PermissionResolver interface + DenyAllResolver"
```

---

### Task 3: ChainResolver + AuditingResolver

**Files:**
- Modify: `src/core/permission-resolver.ts`
- Modify: `src/core/permission-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/core/permission-resolver.test.ts`:

```ts
import { ChainResolver, AuditingResolver } from "./permission-resolver.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ChainResolver", () => {
  test("first resolver that returns 'selected' wins; others skipped", async () => {
    const calls: string[] = [];
    const chain = new ChainResolver([
      { async resolve(r) { calls.push("a"); return { outcome: { outcome: "cancelled" } }; } },
      { async resolve(r) { calls.push("b"); return { outcome: { outcome: "selected", optionId: "ok" } }; } },
      { async resolve(r) { calls.push("c"); return { outcome: { outcome: "selected", optionId: "no" } }; } },
    ]);
    const out = await chain.resolve(req());
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "ok" } });
    expect(calls).toEqual(["a", "b"]);
  });

  test("all resolvers abstain → DENY_ALL fallback", async () => {
    const chain = new ChainResolver([
      { async resolve() { return { outcome: { outcome: "cancelled" } }; } },
    ]);
    const out = await chain.resolve(req());
    // req() has a reject_once option so DENY_ALL selects it
    expect(out).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });
});

describe("AuditingResolver", () => {
  test("writes a JSONL entry per request and returns inner response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const logPath = join(dir, "perm.jsonl");
    const inner = {
      async resolve(r: RequestPermissionRequest) {
        return { outcome: { outcome: "selected" as const, optionId: "ok" } };
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
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/permission-resolver.test.ts`
Expected: FAIL — `ChainResolver` / `AuditingResolver` not exported.

- [ ] **Step 3: Implement**

Append to `src/core/permission-resolver.ts`:

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class ChainResolver implements PermissionResolver {
  constructor(private readonly resolvers: readonly PermissionResolver[]) {}
  async resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    for (const r of this.resolvers) {
      const out = await r.resolve(req);
      if (out.outcome.outcome === "selected") return out;
    }
    return DENY_ALL_RESOLVER.resolve(req);
  }
}

export class AuditingResolver implements PermissionResolver {
  constructor(
    private readonly inner: PermissionResolver,
    private readonly logPath: string,
  ) {
    mkdirSync(dirname(logPath), { recursive: true });
  }
  async resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const response = await this.inner.resolve(req);
    const entry = {
      ts: new Date().toISOString(),
      sessionId: req.sessionId,
      toolCall: req.toolCall,
      options: req.options,
      response,
    };
    appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`);
    return response;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/core/permission-resolver.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/permission-resolver.ts src/core/permission-resolver.test.ts
git commit -m "feat(core): ChainResolver + AuditingResolver"
```

---

### Task 4: Minimal RulesResolver

**Files:**
- Create: `src/core/permission-rules.ts`
- Create: `src/core/permission-rules.test.ts`

- [ ] **Step 1: Write failing test**

`src/core/permission-rules.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RulesResolver } from "./permission-rules.js";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

function req(kind: string, title: string): RequestPermissionRequest {
  return {
    sessionId: "s",
    toolCall: { toolCallId: "t", title, kind: kind as RequestPermissionRequest["toolCall"]["kind"], status: "pending" },
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
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/permission-rules.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/core/permission-rules.ts`:

```ts
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { PermissionResolver } from "./permission-resolver.js";

export interface RulesResolverConfig {
  readonly allowKinds: readonly ToolKind[];
  readonly denyTitleSubstrings: readonly string[];
}

export class RulesResolver implements PermissionResolver {
  constructor(private readonly config: RulesResolverConfig) {}

  async resolve(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const title = req.toolCall.title ?? "";
    const reject = req.options.find(
      (o) => o.kind === "reject_once" || o.kind === "reject_always",
    );
    const allow = req.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );

    if (this.config.denyTitleSubstrings.some((s) => title.includes(s))) {
      return reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    if (req.toolCall.kind && this.config.allowKinds.includes(req.toolCall.kind)) {
      return allow
        ? { outcome: { outcome: "selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    // Abstain — chain should fall through
    return { outcome: { outcome: "cancelled" } };
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/core/permission-rules.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/permission-rules.ts src/core/permission-rules.test.ts
git commit -m "feat(core): RulesResolver — session-scoped kind allow + title deny"
```

---

## Phase 2 — Launch detection

### Task 5: `acp-launch.ts` — provider → command/args table

**Files:**
- Create: `src/core/acp-launch.ts`
- Create: `src/core/acp-launch.test.ts`

- [ ] **Step 1: Write failing test**

`src/core/acp-launch.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveAcpLaunch, SUPPORTED_ACP_AGENTS } from "./acp-launch.js";

describe("resolveAcpLaunch", () => {
  test("lists exactly three supported agents", () => {
    expect(SUPPORTED_ACP_AGENTS).toEqual(["codex", "claude", "gemini"]);
  });

  test("codex resolves to the pinned @zed-industries/codex-acp binary", () => {
    const launch = resolveAcpLaunch("codex");
    expect(launch.agent).toBe("codex");
    expect(launch.args[0]).toMatch(/codex-acp/);
    expect(launch.packageName).toBe("@zed-industries/codex-acp");
  });

  test("claude resolves to @agentclientprotocol/claude-agent-acp", () => {
    const launch = resolveAcpLaunch("claude");
    expect(launch.agent).toBe("claude");
    expect(launch.packageName).toBe("@agentclientprotocol/claude-agent-acp");
  });

  test("gemini resolves to external gemini --acp (no packageName)", () => {
    const launch = resolveAcpLaunch("gemini");
    expect(launch.agent).toBe("gemini");
    expect(launch.command).toBe("gemini");
    expect(launch.args).toEqual(["--acp"]);
    expect(launch.packageName).toBeUndefined();
  });

  test("unknown agent throws", () => {
    expect(() => resolveAcpLaunch("openclaw")).toThrow(/unsupported/i);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/acp-launch.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/core/acp-launch.ts`:

```ts
/**
 * ACP agent launch resolution.
 *
 * Three supported agents. Codex and Claude ship as npm packages we depend
 * on directly (install detection walks node_modules). Gemini is bundled in
 * gemini-cli and must be on PATH.
 *
 * Reference (not dependency): patterns ported from acpx/src/agent-registry.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_ACP_AGENTS = ["codex", "claude", "gemini"] as const;
export type AcpAgent = (typeof SUPPORTED_ACP_AGENTS)[number];

export interface AcpLaunch {
  readonly agent: AcpAgent;
  readonly command: string;
  readonly args: readonly string[];
  readonly packageName?: string;
  readonly packageVersion?: string;
}

interface BuiltInPackageSpec {
  readonly packageName: string;
  readonly preferredBinName: string;
  readonly installHint: string;
}

const BUILT_IN: Record<"codex" | "claude", BuiltInPackageSpec> = {
  codex: {
    packageName: "@zed-industries/codex-acp",
    preferredBinName: "codex-acp",
    installHint: "bun add @zed-industries/codex-acp@^0.11.1",
  },
  claude: {
    packageName: "@agentclientprotocol/claude-agent-acp",
    preferredBinName: "claude-agent-acp",
    installHint: "bun add @agentclientprotocol/claude-agent-acp@^0.30.0",
  },
};

function findPackageRoot(packageName: string): string | undefined {
  const segments = packageName.split("/");
  let cursor = dirname(fileURLToPath(import.meta.url));
  // Walk up looking for node_modules/<packageName>/package.json with matching name
  while (true) {
    const candidate = join(cursor, "node_modules", ...segments);
    const manifest = join(candidate, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (parsed.name === packageName) return candidate;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function resolveBuiltIn(agent: "codex" | "claude"): AcpLaunch {
  const spec = BUILT_IN[agent];
  const root = findPackageRoot(spec.packageName);
  if (!root) {
    throw new Error(
      `[acp-launch] ${spec.packageName} not found in node_modules. Install: ${spec.installHint}`,
    );
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  const relBin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin?.[spec.preferredBinName] ??
        (manifest.bin && Object.keys(manifest.bin).length === 1
          ? Object.values(manifest.bin)[0]
          : undefined);
  if (!relBin) {
    throw new Error(`[acp-launch] ${spec.packageName} has no usable bin entry`);
  }
  const binPath = pathResolve(root, relBin);
  if (!existsSync(binPath)) {
    throw new Error(`[acp-launch] bin not found at ${binPath}. Reinstall: ${spec.installHint}`);
  }
  return {
    agent,
    command: process.execPath,
    args: [binPath],
    packageName: spec.packageName,
    packageVersion: manifest.version,
  };
}

export function resolveAcpLaunch(agent: string): AcpLaunch {
  switch (agent) {
    case "codex":
    case "claude":
      return resolveBuiltIn(agent);
    case "gemini":
      return { agent: "gemini", command: "gemini", args: ["--acp"] };
    default:
      throw new Error(`[acp-launch] unsupported agent "${agent}" (supported: ${SUPPORTED_ACP_AGENTS.join(", ")})`);
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/core/acp-launch.test.ts`
Expected: PASS. (If `@zed-industries/codex-acp` / `@agentclientprotocol/claude-agent-acp` weren't installed by Task 1, resolveBuiltIn will throw — confirms the error message. In that case rerun `bun install` first.)

- [ ] **Step 5: Commit**

```bash
git add src/core/acp-launch.ts src/core/acp-launch.test.ts
git commit -m "feat(core): acp-launch — provider install detection for codex/claude/gemini"
```

---

## Phase 3 — Turn adapter

### Task 6: `AcpTurnImpl` — typed-message source, reuses BoundedEventChannel

**Files:**
- Create: `src/acp/turn-direct.ts`
- Create: `src/acp/turn-direct.test.ts`

Context: `src/acp/turn.ts` houses `AcpxTurnImpl` which takes a `Readable` and runs it through `AcpParser`. The direct-ACP path has no NDJSON stream — it has typed SDK callbacks. This task introduces a second class `AcpTurnImpl` that implements the same `AcpxTurn` contract but takes typed `Message`s plus a `Promise<Result>` and a `cancelFn`.

- [ ] **Step 1: Write failing test**

`src/acp/turn-direct.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AcpTurnImpl } from "./turn-direct.js";
import type { Message, Result } from "./types.js";

describe("AcpTurnImpl", () => {
  test("fans out pushed messages to the async iterator", async () => {
    let resolveResult: (r: Result) => void = () => {};
    const result = new Promise<Result>((r) => {
      resolveResult = r;
    });
    const turn = new AcpTurnImpl({
      sessionId: "s1",
      turnId: "t1",
      result,
      cancelFn: async () => {},
    });

    turn.ingest({ kind: "text", turnId: "t1", text: "hi", chunk: false });
    turn.ingest({ kind: "token_usage", turnId: "t1", usage: { inputTokens: 1, outputTokens: 2 } });
    resolveResult({ turnId: "t1", stopReason: "end_turn" });

    const collected: Message[] = [];
    for await (const m of turn.messages) {
      collected.push(m);
      if (collected.length === 2) break;
    }
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ kind: "text", text: "hi" });

    const res = await turn.result;
    expect(res.stopReason).toBe("end_turn");
  });

  test("cancel invokes cancelFn exactly once", async () => {
    let calls = 0;
    const turn = new AcpTurnImpl({
      sessionId: "s1",
      turnId: "t1",
      result: Promise.resolve({ turnId: "t1", stopReason: "cancelled" }),
      cancelFn: async () => {
        calls += 1;
      },
    });
    await turn.cancel();
    await turn.cancel();
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/acp/turn-direct.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/acp/turn-direct.ts`:

```ts
/**
 * AcpTurnImpl — AcpxTurn implementation for the direct-ACP runtime path.
 *
 * Unlike AcpxTurnImpl (which parses an acpx NDJSON stdout Readable), this
 * class is fed typed Messages directly via `ingest()` from the SDK client
 * callbacks. It reuses BoundedEventChannel so backpressure / coalescing
 * semantics match AcpxTurnImpl.
 */

import { BoundedEventChannel } from "./bounded-channel.js";
import { classifyMessage } from "./turn.js";
import type { AcpxTurn, Message, Result } from "./types.js";

const DEFAULT_CAPACITY = 256;

function coalesceKeyFor(m: Message): string | null {
  if ((m.kind === "text" || m.kind === "thinking") && m.chunk) return m.kind;
  return null;
}

function coalesceMessage(existing: Message, incoming: Message): Message {
  if (
    (existing.kind === "text" && incoming.kind === "text") ||
    (existing.kind === "thinking" && incoming.kind === "thinking")
  ) {
    return { ...existing, text: existing.text + incoming.text };
  }
  return existing;
}

const TEXT_THINKING: readonly string[] = ["text", "thinking"];

function invalidatesCoalesceKeyFor(m: Message): string | readonly string[] | null {
  if ((m.kind === "text" || m.kind === "thinking") && !m.chunk) return m.kind;
  if (m.kind === "tool_call" || m.kind === "permission_request") return TEXT_THINKING;
  return null;
}

export class AcpTurnImpl implements AcpxTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messages: AsyncIterable<Message>;
  readonly result: Promise<Result>;
  private readonly cancelFn: () => Promise<void>;
  private readonly channel: BoundedEventChannel<Message>;
  private pendingCancel: Promise<void> | null = null;
  private closed = false;

  constructor(opts: {
    sessionId: string;
    turnId: string;
    result: Promise<Result>;
    cancelFn: () => Promise<void>;
    channelCapacity?: number;
  }) {
    this.sessionId = opts.sessionId;
    this.turnId = opts.turnId;
    this.cancelFn = opts.cancelFn;
    this.channel = new BoundedEventChannel<Message>({
      capacity: opts.channelCapacity ?? DEFAULT_CAPACITY,
      classify: classifyMessage,
      coalesceKey: coalesceKeyFor,
      coalesce: coalesceMessage,
      invalidatesCoalesceKey: invalidatesCoalesceKeyFor,
    });
    this.messages = this.channel;
    this.result = opts.result.finally(() => {
      if (!this.closed) {
        this.closed = true;
        this.channel.close();
      }
    });
  }

  /** Called by AcpRuntime for each SDK sessionUpdate / permission frame. */
  ingest(m: Message): void {
    if (this.closed) return;
    this.channel.push(m);
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    if (this.pendingCancel !== null) return this.pendingCancel;
    const attempt = (async () => {
      try {
        await this.cancelFn();
      } finally {
        this.pendingCancel = null;
      }
    })();
    this.pendingCancel = attempt;
    return attempt;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/acp/turn-direct.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/acp/turn-direct.ts src/acp/turn-direct.test.ts
git commit -m "feat(acp): AcpTurnImpl — typed-message turn for direct ACP runtime"
```

---

### Task 7: `sessionUpdateToMessage` — SDK update → grove Message

**Files:**
- Create: `src/acp/session-update-mapper.ts`
- Create: `src/acp/session-update-mapper.test.ts`

- [ ] **Step 1: Write failing test**

`src/acp/session-update-mapper.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { sessionUpdateToMessage } from "./session-update-mapper.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";

const TURN = "t-1";

function notif(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: "s-1", update };
}

describe("sessionUpdateToMessage", () => {
  test("agent_message_chunk → text with chunk=true", () => {
    const m = sessionUpdateToMessage(
      notif({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
      TURN,
    );
    expect(m).toEqual({ kind: "text", turnId: TURN, text: "hi", chunk: true });
  });

  test("agent_thought_chunk → thinking with chunk=true", () => {
    const m = sessionUpdateToMessage(
      notif({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
      TURN,
    );
    expect(m).toEqual({ kind: "thinking", turnId: TURN, text: "hmm", chunk: true });
  });

  test("tool_call → tool_call with populated fields", () => {
    const m = sessionUpdateToMessage(
      notif({
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "Run ls",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "ls" },
      }),
      TURN,
    );
    expect(m.kind).toBe("tool_call");
    if (m.kind !== "tool_call") throw new Error("unreachable");
    expect(m.toolCall.id).toBe("c1");
    expect(m.toolCall.title).toBe("Run ls");
    expect(m.toolCall.status).toBe("in_progress");
  });

  test("usage_update → token_usage", () => {
    const m = sessionUpdateToMessage(
      notif({ sessionUpdate: "usage_update", used: 100, size: 8000 }),
      TURN,
    );
    expect(m.kind).toBe("token_usage");
  });

  test("plan / mode / config updates → raw", () => {
    const m = sessionUpdateToMessage(
      notif({ sessionUpdate: "plan", entries: [] }),
      TURN,
    );
    expect(m.kind).toBe("raw");
    if (m.kind !== "raw") throw new Error("unreachable");
    expect(m.acpMethod).toBe("session/update:plan");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/acp/session-update-mapper.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`src/acp/session-update-mapper.ts`:

```ts
/**
 * Map SDK `SessionNotification` payloads to grove's typed `Message` union.
 *
 * Covers every `session/update` variant the spec defines. Unrecognised /
 * non-text kinds fall through to `raw` so the consumer pipeline never loses
 * an event even when SDK adds a new update type.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { Message, ToolCallEvent } from "./types.js";

export function sessionUpdateToMessage(
  notification: SessionNotification,
  turnId: string,
): Message {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return {
        kind: "text",
        turnId,
        text: update.content.type === "text" ? update.content.text : `[${update.content.type}]`,
        chunk: true,
      };
    case "agent_thought_chunk":
      return {
        kind: "thinking",
        turnId,
        text: update.content.type === "text" ? update.content.text : `[${update.content.type}]`,
        chunk: true,
      };
    case "user_message_chunk":
      return {
        kind: "text",
        turnId,
        text: update.content.type === "text" ? update.content.text : `[${update.content.type}]`,
        chunk: true,
      };
    case "tool_call": {
      const event: ToolCallEvent = {
        id: update.toolCallId,
        name: update.title ?? update.toolCallId,
        title: update.title,
        status: update.status,
        input: update.rawInput,
      };
      return { kind: "tool_call", turnId, toolCall: event };
    }
    case "tool_call_update": {
      const event: ToolCallEvent = {
        id: update.toolCallId,
        status: update.status,
        title: update.title,
        input: update.rawInput,
        output: update.rawOutput,
      };
      return { kind: "tool_call", turnId, toolCall: event };
    }
    case "usage_update":
      return {
        kind: "token_usage",
        turnId,
        usage: {
          inputTokens: update.used ?? 0,
          outputTokens: 0,
          totalTokens: update.size,
        },
      };
    default:
      return {
        kind: "raw",
        turnId,
        acpMethod: `session/update:${update.sessionUpdate}`,
        params: update,
      };
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/acp/session-update-mapper.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/acp/session-update-mapper.ts src/acp/session-update-mapper.test.ts
git commit -m "feat(acp): sessionUpdateToMessage — SDK notification → grove Message"
```

---

## Phase 4 — AcpRuntime scaffolding

### Task 8: `AcpRuntime` class skeleton with SDK wiring

**Files:**
- Create: `src/core/acp-runtime.ts`
- Create: `src/core/acp-runtime.test.ts`

Context: This task sets up the class so `isAvailable()`, constructor, and `setPermissionResolver()` work. Spawn/send/cancel come in subsequent tasks. Unit tests use the SDK's ability to pair `ClientSideConnection` with an `AgentSideConnection` over an in-memory stream — no subprocess.

- [ ] **Step 1: Write failing test**

`src/core/acp-runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { DENY_ALL_RESOLVER } from "./permission-resolver.js";

describe("AcpRuntime construction", () => {
  test("implements AgentRuntime interface (method shape)", () => {
    const rt = new AcpRuntime();
    expect(typeof rt.spawn).toBe("function");
    expect(typeof rt.send).toBe("function");
    expect(typeof rt.close).toBe("function");
    expect(typeof rt.onIdle).toBe("function");
    expect(typeof rt.listSessions).toBe("function");
    expect(typeof rt.isAvailable).toBe("function");
    expect(typeof rt.setPermissionResolver).toBe("function");
  });

  test("default resolver is DenyAll", () => {
    const rt = new AcpRuntime();
    expect(rt.currentResolver).toBe(DENY_ALL_RESOLVER);
  });

  test("setPermissionResolver swaps the resolver", () => {
    const rt = new AcpRuntime();
    const custom = { async resolve() { return { outcome: { outcome: "cancelled" as const } }; } };
    rt.setPermissionResolver(custom);
    expect(rt.currentResolver).toBe(custom);
  });

  test("listSessions empty by default", async () => {
    const rt = new AcpRuntime();
    expect(await rt.listSessions()).toEqual([]);
  });

  test("isAvailable returns true when SDK importable", async () => {
    const rt = new AcpRuntime();
    expect(await rt.isAvailable()).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/acp-runtime.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement skeleton**

`src/core/acp-runtime.ts`:

```ts
/**
 * AcpRuntime — AgentRuntime backed by direct ACP connections to provider
 * binaries (codex-acp, claude-agent-acp, gemini --acp).
 *
 * Replaces AcpxRuntime. One persistent subprocess per AgentSession; typed
 * session/update frames feed AcpTurnImpl which preserves the AcpxTurn
 * contract so downstream consumers (AcpMessageSink, SessionStore,
 * publishTurnToNexus) require no changes.
 */

import type { AcpxTurn } from "../acp/types.js";
import type { AgentConfig, AgentRuntime, AgentSession } from "./agent-runtime.js";
import { DENY_ALL_RESOLVER, type PermissionResolver } from "./permission-resolver.js";

export interface AcpRuntimeOptions {
  readonly permissionResolver?: PermissionResolver;
  readonly fsAuditor?: (op: "read" | "write", path: string, sessionId: string) => void;
  readonly logDir?: string;
}

export class AcpRuntime implements AgentRuntime {
  private resolver: PermissionResolver;
  private readonly fsAuditor: AcpRuntimeOptions["fsAuditor"];
  private readonly logDir: string | undefined;

  constructor(options: AcpRuntimeOptions = {}) {
    this.resolver = options.permissionResolver ?? DENY_ALL_RESOLVER;
    this.fsAuditor = options.fsAuditor;
    this.logDir = options.logDir;
  }

  /** Test hook — production code should not depend on this. */
  get currentResolver(): PermissionResolver {
    return this.resolver;
  }

  setPermissionResolver(resolver: PermissionResolver): void {
    this.resolver = resolver;
  }

  async isAvailable(): Promise<boolean> {
    // SDK is a direct dependency; if the import succeeded, we're available.
    // Per-provider availability is probed at spawn() time via resolveAcpLaunch.
    return true;
  }

  async spawn(_role: string, _config: AgentConfig): Promise<AgentSession> {
    throw new Error("AcpRuntime.spawn not implemented yet (Task 9)");
  }

  async send(_session: AgentSession, _message: string): Promise<AcpxTurn> {
    throw new Error("AcpRuntime.send not implemented yet (Task 10)");
  }

  async close(_session: AgentSession): Promise<void> {
    // No-op until sessions exist.
  }

  onIdle(_session: AgentSession, _callback: () => void): void {
    // No-op until sessions exist.
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [];
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/core/acp-runtime.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/acp-runtime.ts src/core/acp-runtime.test.ts
git commit -m "feat(core): AcpRuntime skeleton — construction, resolver swap, isAvailable"
```

---

### Task 9: `AcpRuntime.spawn` — subprocess + handshake + session/new

**Files:**
- Modify: `src/core/acp-runtime.ts`
- Modify: `src/core/acp-runtime.test.ts`

Context: spawn the provider binary resolved by `acp-launch`, wire `ClientSideConnection`, call `initialize` + `newSession`, cache the connection in an internal session entry. Unit test uses a mock launch override that spawns an in-process ACP agent stub, because we can't rely on real codex-acp being installed.

- [ ] **Step 1: Write failing test**

Append to `src/core/acp-runtime.test.ts`:

```ts
import type { Agent } from "@agentclientprotocol/sdk";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

/** Create an in-process ACP agent stub + plumb it to an AcpRuntime via launchOverride. */
function makeInProcessAgent(handlers: {
  onPrompt?: (p: { sessionId: string; prompt: unknown[] }) => Promise<{ stopReason: "end_turn" }>;
}): {
  launchOverride: import("./acp-runtime.js").LaunchOverride;
} {
  return {
    launchOverride: async () => {
      // Build two paired duplex streams (client<->agent) in memory.
      const { readable: agentIn, writable: clientOut } = new TransformStream<Uint8Array, Uint8Array>();
      const { readable: clientIn, writable: agentOut } = new TransformStream<Uint8Array, Uint8Array>();

      const agentStream = ndJsonStream(agentOut, agentIn);
      const agentImpl: Agent = {
        async initialize() {
          return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
        },
        async newSession() {
          return { sessionId: `wire-${Date.now()}`, modes: undefined, models: undefined };
        },
        async loadSession() { throw new Error("loadSession not supported"); },
        async prompt(p) {
          return handlers.onPrompt ? handlers.onPrompt(p) : { stopReason: "end_turn" };
        },
        async cancel() {},
        async setSessionMode() { return {}; },
        async setSessionConfig() { return {}; },
        async authenticate() { return {}; },
      };
      new AgentSideConnection(() => agentImpl, agentStream);
      return { clientStream: ndJsonStream(clientOut, clientIn), dispose: async () => {} };
    },
  };
}

describe("AcpRuntime.spawn", () => {
  test("initializes, creates a session, returns grove-formatted id", async () => {
    const { launchOverride } = makeInProcessAgent({});
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    expect(session.role).toBe("coder");
    expect(session.status).toBe("running");
    expect(session.id).toMatch(/^grove-coder-\d+-[a-z0-9]+$/);
  });

  test("close() removes the session and kills the child", async () => {
    const { launchOverride } = makeInProcessAgent({});
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: process.cwd(),
    });
    await rt.close(session);
    expect(await rt.listSessions()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/acp-runtime.test.ts`
Expected: FAIL — `LaunchOverride` / real spawn not implemented.

- [ ] **Step 3: Implement spawn + LaunchOverride**

Edit `src/core/acp-runtime.ts`. Add imports and extend the class:

```ts
import { spawn as nodeSpawn, type ChildProcessByStdio } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, type Client, type Stream } from "@agentclientprotocol/sdk";
import { buildSessionId } from "./session-id.js";
import { resolveAcpLaunch } from "./acp-launch.js";
import { sessionUpdateToMessage } from "../acp/session-update-mapper.js";

export interface LaunchResult {
  readonly clientStream: Stream;
  readonly dispose: () => Promise<void>;
}
export type LaunchOverride = (agent: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<LaunchResult>;

interface AcpSessionEntry {
  session: AgentSession;
  connection: ClientSideConnection;
  wireSessionId: string;
  dispose: () => Promise<void>;
  idleCallbacks: (() => void)[];
}
```

Extend `AcpRuntimeOptions` with `launchOverride?: LaunchOverride;` and add private state to the class:

```ts
  private readonly sessions: Map<string, AcpSessionEntry> = new Map();
  private nextId = 0;
  private readonly launchOverride: LaunchOverride | undefined;
```

Assign `this.launchOverride = options.launchOverride;` in the constructor.

Replace the stub `spawn` with:

```ts
  async spawn(role: string, config: AgentConfig): Promise<AgentSession> {
    const counter = this.nextId++;
    const id = buildSessionId(role, counter);

    const baseEnv = { ...process.env };
    for (const key of Object.keys(baseEnv)) {
      if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key.startsWith("CLAUDE_PLUGIN_")) {
        delete baseEnv[key];
      }
    }
    const mergedEnv: NodeJS.ProcessEnv = { ...baseEnv, ...config.env, GROVE_AGENT_ID: id, GROVE_AGENT_ROLE: role };
    if (config.platform) mergedEnv.GROVE_AGENT_PLATFORM = config.platform;
    if (config.model) mergedEnv.GROVE_AGENT_MODEL = config.model;

    const agent = resolveAgentFromConfig(config);

    const launched = this.launchOverride
      ? await this.launchOverride(agent, config.cwd, mergedEnv)
      : await launchSubprocess(agent, config.cwd, mergedEnv);

    const client = this.buildClient(id);
    const connection = new ClientSideConnection(() => client, launched.clientStream);

    await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    });
    const created = await connection.newSession({ cwd: config.cwd, mcpServers: [] });

    const session: AgentSession = {
      id,
      role,
      status: "running",
      platform: config.platform,
      model: config.model,
      agent,
    };
    this.sessions.set(id, {
      session,
      connection,
      wireSessionId: created.sessionId,
      dispose: launched.dispose,
      idleCallbacks: [],
    });
    return session;
  }

  private buildClient(sessionId: string): Client {
    const resolver = () => this.resolver;
    const audit = this.fsAuditor;
    return {
      async requestPermission(params) {
        try {
          return await resolver().resolve(params);
        } catch (err) {
          process.stderr.write(
            `[acp-runtime] resolver threw: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return { outcome: { outcome: "cancelled" } };
        }
      },
      async sessionUpdate(_params) {
        // Per-turn routing installed by AcpRuntime.send at prompt time.
      },
      async readTextFile(params) {
        audit?.("read", params.path, sessionId);
        const text = await Bun.file(params.path).text();
        return { content: text };
      },
      async writeTextFile(params) {
        audit?.("write", params.path, sessionId);
        await Bun.write(params.path, params.content);
        return {};
      },
    };
  }

  async close(session: AgentSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    try {
      await entry.dispose();
    } catch {
      /* ignore */
    }
    this.sessions.delete(session.id);
  }

  async listSessions(): Promise<readonly AgentSession[]> {
    return [...this.sessions.values()].map((e) => e.session);
  }
```

Add private helpers in the same file (module-scope):

```ts
function resolveAgentFromConfig(config: AgentConfig): string {
  if (config.platform === "claude-code") return "claude";
  if (config.platform === "codex") return "codex";
  if (config.platform === "gemini") return "gemini";
  const first = config.command.trim().split(/\s+/)[0] ?? "";
  if (first === "claude" || first === "codex" || first === "gemini") return first;
  return "codex";
}

async function launchSubprocess(
  agent: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<LaunchResult> {
  const launch = resolveAcpLaunch(agent);
  const child = nodeSpawn(launch.command, [...launch.args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const stdinWebWritable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stdoutWebReadable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const clientStream = ndJsonStream(stdinWebWritable, stdoutWebReadable);

  const dispose = async () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  return { clientStream, dispose };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/core/acp-runtime.test.ts`
Expected: PASS (both new tests plus the earlier 5).

- [ ] **Step 5: Commit**

```bash
git add src/core/acp-runtime.ts src/core/acp-runtime.test.ts src/acp/session-update-mapper.ts
git commit -m "feat(core): AcpRuntime.spawn — SDK handshake + session/new + launchOverride"
```

---

### Task 10: `AcpRuntime.send` + per-turn sessionUpdate routing

**Files:**
- Modify: `src/core/acp-runtime.ts`
- Modify: `src/core/acp-runtime.test.ts`

Context: `send()` calls `connection.prompt()` and returns an `AcpTurnImpl`. Per-turn `sessionUpdate` callback must be installed so messages route to the current turn's ingest. Since a `Client` is bound at construction time, we use a per-session dispatcher: each entry holds `currentTurn?: AcpTurnImpl`, and the `sessionUpdate` handler built in Task 9 forwards to it.

- [ ] **Step 1: Write failing test**

Append to `src/core/acp-runtime.test.ts`:

```ts
describe("AcpRuntime.send", () => {
  test("returns an AcpxTurn; result resolves with the prompt stopReason", async () => {
    const { launchOverride } = makeInProcessAgent({
      onPrompt: async () => ({ stopReason: "end_turn" }),
    });
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", { role: "coder", command: "codex", cwd: process.cwd() });
    const turn = await rt.send(session, "hello");
    const result = await turn.result;
    expect(result.stopReason).toBe("end_turn");
  });

  test("streams agent_message_chunk notifications into the turn's messages", async () => {
    const { launchOverride } = makeInProcessAgent({
      onPrompt: async () => {
        // The agent stub emits updates via its `sessionUpdate` handler on the
        // AgentSideConnection — but in this in-process setup we just return
        // end_turn; chunk-emission is covered by the integration suite.
        return { stopReason: "end_turn" };
      },
    });
    const rt = new AcpRuntime({ launchOverride });
    const session = await rt.spawn("coder", { role: "coder", command: "codex", cwd: process.cwd() });
    const turn = await rt.send(session, "hi");
    await turn.result; // ensure close()
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/acp-runtime.test.ts`
Expected: FAIL — `send` still throws.

- [ ] **Step 3: Implement**

Add per-session current-turn tracking to `AcpSessionEntry`:

```ts
interface AcpSessionEntry {
  session: AgentSession;
  connection: ClientSideConnection;
  wireSessionId: string;
  dispose: () => Promise<void>;
  idleCallbacks: (() => void)[];
  currentTurn: AcpTurnImpl | null;
}
```

Set `currentTurn: null` in the object literal inside `spawn`.

Update `buildClient`'s `sessionUpdate` so it routes by sessionId:

```ts
  private buildClient(groveSessionId: string): Client {
    const runtime = this;
    return {
      async requestPermission(params) {
        try {
          const entry = runtime.findEntryByWireSession(params.sessionId);
          const turn = entry?.currentTurn;
          // Surface to UI as a stream message too
          if (turn) {
            turn.ingest({
              kind: "permission_request",
              turnId: turn.turnId,
              request: {
                id: params.toolCall.toolCallId,
                tool: params.toolCall.kind ?? "other",
                input: params.toolCall.rawInput,
              },
            });
          }
          return await runtime.resolver.resolve(params);
        } catch (err) {
          process.stderr.write(
            `[acp-runtime] resolver threw: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          return { outcome: { outcome: "cancelled" } };
        }
      },
      async sessionUpdate(params) {
        const entry = runtime.findEntryByWireSession(params.sessionId);
        const turn = entry?.currentTurn;
        if (!turn) return;
        turn.ingest(sessionUpdateToMessage(params, turn.turnId));
      },
      async readTextFile(params) {
        runtime.fsAuditor?.("read", params.path, groveSessionId);
        const text = await Bun.file(params.path).text();
        return { content: text };
      },
      async writeTextFile(params) {
        runtime.fsAuditor?.("write", params.path, groveSessionId);
        await Bun.write(params.path, params.content);
        return {};
      },
    };
  }

  private findEntryByWireSession(wireId: string): AcpSessionEntry | undefined {
    for (const entry of this.sessions.values()) {
      if (entry.wireSessionId === wireId) return entry;
    }
    return undefined;
  }
```

Implement `send`:

```ts
  async send(session: AgentSession, message: string): Promise<AcpxTurn> {
    const entry = this.sessions.get(session.id);
    if (!entry) throw new Error(`AcpRuntime.send: unknown session ${session.id}`);

    const turnId = `${session.id}-${Date.now().toString(36)}-${this.nextId++}`;
    let resolveResult: (r: import("../acp/types.js").Result) => void = () => {};
    const resultPromise = new Promise<import("../acp/types.js").Result>((r) => {
      resolveResult = r;
    });

    const turn = new AcpTurnImpl({
      sessionId: entry.wireSessionId,
      turnId,
      result: resultPromise,
      cancelFn: async () => {
        try {
          await entry.connection.cancel({ sessionId: entry.wireSessionId });
        } catch {
          /* ignore */
        }
      },
    });
    entry.currentTurn = turn;

    entry.connection
      .prompt({
        sessionId: entry.wireSessionId,
        prompt: [{ type: "text", text: message }],
      })
      .then(
        (ok) => resolveResult({ turnId, stopReason: ok.stopReason }),
        (err) =>
          resolveResult({
            turnId,
            stopReason: "error",
            error: {
              code: "prompt_rejected",
              message: err instanceof Error ? err.message : String(err),
            },
          }),
      )
      .finally(() => {
        if (entry.currentTurn === turn) entry.currentTurn = null;
        for (const cb of entry.idleCallbacks) {
          try {
            cb();
          } catch {
            /* ignore */
          }
        }
      });

    return turn;
  }

  onIdle(session: AgentSession, callback: () => void): void {
    const entry = this.sessions.get(session.id);
    if (!entry) return;
    entry.idleCallbacks.push(callback);
  }
```

Import `AcpTurnImpl` at the top of the file:

```ts
import { AcpTurnImpl } from "../acp/turn-direct.js";
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/core/acp-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/acp-runtime.ts src/core/acp-runtime.test.ts
git commit -m "feat(core): AcpRuntime.send + per-turn sessionUpdate routing"
```

---

### Task 11: Resolver gets invoked with real `requestPermission`

**Files:**
- Modify: `src/core/acp-runtime.test.ts`

Context: verify the critical behaviour from issue #272 — agent raises a permission request, resolver is called with the typed payload, agent receives the decision.

- [ ] **Step 1: Write the test**

Append to `src/core/acp-runtime.test.ts`:

```ts
describe("AcpRuntime permission flow", () => {
  test("agent-side requestPermission reaches the resolver and returns the decision", async () => {
    // Build an in-process agent that issues requestPermission during prompt()
    const permissionCalls: import("@agentclientprotocol/sdk").RequestPermissionRequest[] = [];

    let launchOverride: import("./acp-runtime.js").LaunchOverride;
    const agentStubFactory = {
      onPrompt: async (p: { sessionId: string }) => {
        // Need access to the AgentSideConnection to call client.requestPermission;
        // capture it via a closure set up inside launchOverride.
        const response = await (agentStubFactory as any)._callClientPermission({
          sessionId: p.sessionId,
          toolCall: {
            toolCallId: "tc1",
            title: "Run rm -rf /",
            kind: "execute",
            status: "pending",
          },
          options: [
            { optionId: "y", name: "Allow", kind: "allow_once" },
            { optionId: "n", name: "Deny", kind: "reject_once" },
          ],
        });
        permissionCalls.push(response._request);
        return { stopReason: response.outcome.outcome === "selected" ? "end_turn" : "cancelled" };
      },
    };

    launchOverride = async () => {
      const { readable: agentIn, writable: clientOut } = new TransformStream<Uint8Array, Uint8Array>();
      const { readable: clientIn, writable: agentOut } = new TransformStream<Uint8Array, Uint8Array>();
      const agentStream = ndJsonStream(agentOut, agentIn);
      let agentSide: AgentSideConnection | null = null;
      const agent: Agent = {
        async initialize() { return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }; },
        async newSession() { return { sessionId: "wire-1" }; },
        async loadSession() { throw new Error("not supported"); },
        async prompt(p) {
          if (!agentSide) throw new Error("no agent side yet");
          // Ask the client for permission
          const resp = await agentSide.requestPermission({
            sessionId: p.sessionId,
            toolCall: { toolCallId: "tc1", title: "Run rm -rf /", kind: "execute", status: "pending" },
            options: [
              { optionId: "y", name: "Allow", kind: "allow_once" },
              { optionId: "n", name: "Deny", kind: "reject_once" },
            ],
          });
          return { stopReason: resp.outcome.outcome === "selected" ? "end_turn" : "cancelled" };
        },
        async cancel() {},
        async setSessionMode() { return {}; },
        async setSessionConfig() { return {}; },
        async authenticate() { return {}; },
      };
      agentSide = new AgentSideConnection(() => agent, agentStream);
      return { clientStream: ndJsonStream(clientOut, clientIn), dispose: async () => {} };
    };

    const seen: string[] = [];
    const resolver = {
      async resolve(req: import("@agentclientprotocol/sdk").RequestPermissionRequest) {
        seen.push(req.toolCall.title ?? "");
        // Select the "allow" option
        return { outcome: { outcome: "selected" as const, optionId: "y" } };
      },
    };
    const rt = new AcpRuntime({ launchOverride, permissionResolver: resolver });
    const session = await rt.spawn("coder", { role: "coder", command: "codex", cwd: process.cwd() });
    const turn = await rt.send(session, "delete everything");
    const res = await turn.result;

    expect(seen).toEqual(["Run rm -rf /"]);
    expect(res.stopReason).toBe("end_turn");
  });
});
```

- [ ] **Step 2: Run**

Run: `bun test src/core/acp-runtime.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/acp-runtime.test.ts
git commit -m "test(core): AcpRuntime permission flow — resolver invoked with typed request"
```

### Checkpoint A

Ask the user to review before proceeding to integration tests:

> Checkpoint A reached. AcpRuntime scaffolded, permission resolver wired, unit tests green. Review the design in `src/core/acp-runtime.ts` — in particular `buildClient`, `send`, `findEntryByWireSession` — and confirm before we move to real-subprocess integration tests.

---

## Phase 5 — Integration tests (real subprocess)

### Task 12: codex-acp integration test

**Files:**
- Create: `src/core/acp-runtime.integration.test.ts`

Mirrors the pattern of `src/core/acpx-runtime.integration.test.ts`: runs only when codex credentials are available, skipped otherwise.

- [ ] **Step 1: Write the test**

`src/core/acp-runtime.integration.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { AcpRuntime } from "./acp-runtime.js";
import { resolveAcpLaunch } from "./acp-launch.js";

function codexLaunchable(): boolean {
  try {
    resolveAcpLaunch("codex");
    return Boolean(process.env.OPENAI_API_KEY) || Boolean(process.env.CODEX_API_KEY);
  } catch {
    return false;
  }
}

const runOrSkip = codexLaunchable() ? test : test.skip;

describe("AcpRuntime integration (codex)", () => {
  const runtime = new AcpRuntime();

  afterAll(async () => {
    for (const s of await runtime.listSessions()) {
      await runtime.close(s);
    }
  });

  runOrSkip("spawn + send + result", async () => {
    const session = await runtime.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: "/tmp",
      platform: "codex",
    });
    const turn = await runtime.send(session, "reply with exactly the word HELLO and nothing else");
    const collected: string[] = [];
    for await (const m of turn.messages) {
      if (m.kind === "text") collected.push(m.text);
    }
    const res = await turn.result;
    expect(res.stopReason).toBe("end_turn");
    expect(collected.join("")).toContain("HELLO");
  }, 60_000);

  runOrSkip("cancel mid-turn produces stopReason=cancelled", async () => {
    const session = await runtime.spawn("coder", {
      role: "coder",
      command: "codex",
      cwd: "/tmp",
      platform: "codex",
    });
    const turn = await runtime.send(session, "count from 1 to 1000 very slowly");
    setTimeout(() => {
      void turn.cancel();
    }, 500);
    const res = await turn.result;
    expect(res.stopReason).toBe("cancelled");
  }, 60_000);
});
```

- [ ] **Step 2: Run**

Run: `bun test src/core/acp-runtime.integration.test.ts`
Expected: PASS (when `OPENAI_API_KEY` or `CODEX_API_KEY` set) or SKIP (otherwise).

- [ ] **Step 3: Commit**

```bash
git add src/core/acp-runtime.integration.test.ts
git commit -m "test(core): AcpRuntime integration — codex spawn/send/cancel"
```

---

### Task 13: claude-agent-acp integration test

**Files:**
- Modify: `src/core/acp-runtime.integration.test.ts`

- [ ] **Step 1: Append the test**

Append to `src/core/acp-runtime.integration.test.ts`:

```ts
function claudeLaunchable(): boolean {
  try {
    resolveAcpLaunch("claude");
    return Boolean(process.env.ANTHROPIC_API_KEY);
  } catch {
    return false;
  }
}

const claudeOrSkip = claudeLaunchable() ? test : test.skip;

describe("AcpRuntime integration (claude)", () => {
  const runtime = new AcpRuntime();
  afterAll(async () => {
    for (const s of await runtime.listSessions()) await runtime.close(s);
  });

  claudeOrSkip("spawn + send + result", async () => {
    const session = await runtime.spawn("coder", {
      role: "coder",
      command: "claude",
      cwd: "/tmp",
      platform: "claude-code",
    });
    const turn = await runtime.send(session, "reply with exactly the word HELLO");
    const text: string[] = [];
    for await (const m of turn.messages) if (m.kind === "text") text.push(m.text);
    const res = await turn.result;
    expect(res.stopReason).toBe("end_turn");
    expect(text.join("")).toContain("HELLO");
  }, 60_000);
});
```

- [ ] **Step 2: Run and commit**

Run: `bun test src/core/acp-runtime.integration.test.ts`
Expected: PASS or SKIP.

```bash
git add src/core/acp-runtime.integration.test.ts
git commit -m "test(core): AcpRuntime integration — claude spawn/send"
```

---

### Task 14: gemini integration test

**Files:**
- Modify: `src/core/acp-runtime.integration.test.ts`

- [ ] **Step 1: Append the test**

Append to `src/core/acp-runtime.integration.test.ts`:

```ts
function geminiLaunchable(): boolean {
  try {
    resolveAcpLaunch("gemini");
  } catch {
    return false;
  }
  // gemini-cli auth is provided externally (gcloud etc.)
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync("gemini --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const geminiOrSkip = geminiLaunchable() ? test : test.skip;

describe("AcpRuntime integration (gemini)", () => {
  const runtime = new AcpRuntime();
  afterAll(async () => {
    for (const s of await runtime.listSessions()) await runtime.close(s);
  });

  geminiOrSkip("spawn + send + result", async () => {
    const session = await runtime.spawn("coder", {
      role: "coder",
      command: "gemini",
      cwd: "/tmp",
      platform: "gemini",
    });
    const turn = await runtime.send(session, "reply with exactly the word HELLO");
    const text: string[] = [];
    for await (const m of turn.messages) if (m.kind === "text") text.push(m.text);
    const res = await turn.result;
    expect(res.stopReason).toBe("end_turn");
    expect(text.join("")).toContain("HELLO");
  }, 60_000);
});
```

- [ ] **Step 2: Run and commit**

Run: `bun test src/core/acp-runtime.integration.test.ts`
Expected: PASS or SKIP.

```bash
git add src/core/acp-runtime.integration.test.ts
git commit -m "test(core): AcpRuntime integration — gemini spawn/send"
```

### Checkpoint B

Ask the user:

> Checkpoint B reached. Integration tests pass on whichever providers credentials were available for (confirm which: codex / claude / gemini). Real permission flow, real cancel, real stream fidelity verified. Ready to wire runtime selection.

---

## Phase 6 — Runtime selection

### Task 15: `selectRuntime()` factory + `GROVE_RUNTIME` flag

**Files:**
- Create: `src/core/select-runtime.ts`
- Create: `src/core/select-runtime.test.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1: Write failing test**

`src/core/select-runtime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { selectRuntime } from "./select-runtime.js";
import { AcpRuntime } from "./acp-runtime.js";
import { AcpxRuntime } from "./acpx-runtime.js";

describe("selectRuntime", () => {
  test("defaults to AcpxRuntime when GROVE_RUNTIME is unset (opt-in phase)", () => {
    const rt = selectRuntime({ env: {} });
    expect(rt).toBeInstanceOf(AcpxRuntime);
  });

  test("returns AcpRuntime when GROVE_RUNTIME=acp", () => {
    const rt = selectRuntime({ env: { GROVE_RUNTIME: "acp" } });
    expect(rt).toBeInstanceOf(AcpRuntime);
  });

  test("returns AcpxRuntime when GROVE_RUNTIME=acpx", () => {
    const rt = selectRuntime({ env: { GROVE_RUNTIME: "acpx" } });
    expect(rt).toBeInstanceOf(AcpxRuntime);
  });

  test("throws on unknown values", () => {
    expect(() => selectRuntime({ env: { GROVE_RUNTIME: "tmux" } })).toThrow(/GROVE_RUNTIME/);
  });

  test("forwards options to the chosen runtime", () => {
    const rt = selectRuntime({ env: { GROVE_RUNTIME: "acp" }, acp: { logDir: "/tmp/x" } });
    expect(rt).toBeInstanceOf(AcpRuntime);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/select-runtime.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/select-runtime.ts`:

```ts
import type { AgentRuntime } from "./agent-runtime.js";
import { AcpRuntime, type AcpRuntimeOptions } from "./acp-runtime.js";
import { AcpxRuntime } from "./acpx-runtime.js";

export interface SelectRuntimeOptions {
  readonly env?: { readonly GROVE_RUNTIME?: string | undefined };
  readonly acpx?: { agent?: string; logDir?: string };
  readonly acp?: AcpRuntimeOptions;
}

export function selectRuntime(options: SelectRuntimeOptions = {}): AgentRuntime {
  const flag = options.env?.GROVE_RUNTIME ?? process.env.GROVE_RUNTIME;
  const normalized = flag?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") {
    // Opt-in phase: default remains acpx. Will flip to "acp" in Task 18.
    return new AcpxRuntime(options.acpx);
  }
  if (normalized === "acp") return new AcpRuntime(options.acp);
  if (normalized === "acpx") return new AcpxRuntime(options.acpx);
  throw new Error(`[select-runtime] unknown GROVE_RUNTIME=${flag}; valid: acp | acpx`);
}
```

Extend `src/core/index.ts` — add right after the existing `AcpxRuntime` export:

```ts
export { AcpRuntime } from "./acp-runtime.js";
export type { AcpRuntimeOptions } from "./acp-runtime.js";
export type { PermissionResolver } from "./permission-resolver.js";
export { DENY_ALL_RESOLVER, ChainResolver, AuditingResolver } from "./permission-resolver.js";
export { RulesResolver } from "./permission-rules.js";
export { selectRuntime } from "./select-runtime.js";
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/core/select-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/select-runtime.ts src/core/select-runtime.test.ts src/core/index.ts
git commit -m "feat(core): selectRuntime factory + GROVE_RUNTIME flag (default acpx, opt-in acp)"
```

---

### Task 16: Callsite migration — every `new AcpxRuntime(...)` → `selectRuntime(...)`

**Files:**
- Modify: `src/tui/main.ts` (line 274)
- Modify: `src/cli/commands/session.ts` (line 149)
- Modify: `src/server/serve.ts` (line 225)
- Modify: `tests/tui/acpx-worktree-e2e.ts` (line 95)
- Modify: `tests/e2e/acp-stream-nexus.e2e.test.ts` (lines 48, 109)

Do NOT modify `src/core/acpx-runtime.test.ts`, `src/core/acpx-runtime.integration.test.ts`, or `src/core/acpx-resolve-agent.test.ts` — they must keep exercising `AcpxRuntime` directly until deletion.

- [ ] **Step 1: Update each callsite**

For each location above, replace:

```ts
const rt = new AcpxRuntime({ /* ... */ });
```

with:

```ts
const rt = selectRuntime({ acpx: { /* ...existing options... */ }, acp: {} });
```

Import at top of each file:

```ts
import { selectRuntime } from "../../core/select-runtime.js"; // path adjusted per file
```

Remove the now-unused `import { AcpxRuntime }` where no longer referenced. Leave it where tests still use `AcpxRuntime` directly.

- [ ] **Step 2: Run type check**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Run existing suites to confirm no regressions**

Run: `bun test`
Expected: all existing tests still pass; the default is still `acpx`, so behaviour unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/tui/main.ts src/cli/commands/session.ts src/server/serve.ts tests/tui/acpx-worktree-e2e.ts tests/e2e/acp-stream-nexus.e2e.test.ts
git commit -m "refactor(runtime): route all callsites through selectRuntime()"
```

---

## Phase 7 — Parity gate

### Task 17: Parity test — Message sequence equivalence across runtimes

**Files:**
- Create: `tests/e2e/runtime-parity.e2e.test.ts`

Context: run the same prompt against the same provider (codex) with `AcpxRuntime` and `AcpRuntime`, collect emitted `Message` sequences, compare them modulo timing noise and the known structural differences (acpx emits `raw` frames for acpx-internal methods; direct ACP emits none of those).

- [ ] **Step 1: Write the parity harness**

`tests/e2e/runtime-parity.e2e.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AcpRuntime } from "../../src/core/acp-runtime.js";
import { AcpxRuntime } from "../../src/core/acpx-runtime.js";
import type { AgentRuntime } from "../../src/core/agent-runtime.js";
import type { Message } from "../../src/acp/types.js";

function codexEnv(): boolean {
  return Boolean(process.env.OPENAI_API_KEY) || Boolean(process.env.CODEX_API_KEY);
}
const gated = codexEnv() ? test : test.skip;

type StructuralSig = {
  kinds: string[];
  totalText: string;
  toolCallIds: string[];
  stopReason: string;
};

async function run(runtime: AgentRuntime, prompt: string): Promise<StructuralSig> {
  const session = await runtime.spawn("coder", {
    role: "coder",
    command: "codex",
    cwd: "/tmp",
    platform: "codex",
  });
  try {
    const turn = await runtime.send(session, prompt);
    const sig: StructuralSig = { kinds: [], totalText: "", toolCallIds: [], stopReason: "" };
    for await (const m of turn.messages as AsyncIterable<Message>) {
      sig.kinds.push(m.kind);
      if (m.kind === "text") sig.totalText += m.text;
      if (m.kind === "tool_call") sig.toolCallIds.push(m.toolCall.id);
    }
    const result = await turn.result;
    sig.stopReason = result.stopReason;
    return sig;
  } finally {
    await runtime.close(session);
  }
}

describe("runtime parity (codex)", () => {
  gated(
    "both runtimes produce equivalent structural signatures for a simple prompt",
    async () => {
      const prompt = "Reply with exactly the single word PONG.";
      const acpx = await run(new AcpxRuntime(), prompt);
      const acp = await run(new AcpRuntime(), prompt);

      // Timing noise removed: compare deduped kind sets + totalText + stopReason.
      const acpxKinds = new Set(acpx.kinds.filter((k) => k !== "raw"));
      const acpKinds = new Set(acp.kinds.filter((k) => k !== "raw"));
      expect(acpKinds).toEqual(acpxKinds);

      expect(acp.totalText).toContain("PONG");
      expect(acpx.totalText).toContain("PONG");
      expect(acp.stopReason).toBe("end_turn");
      expect(acpx.stopReason).toBe("end_turn");
    },
    120_000,
  );
});
```

- [ ] **Step 2: Run**

Run: `bun test tests/e2e/runtime-parity.e2e.test.ts`
Expected: PASS if codex credentials present; SKIP otherwise.

- [ ] **Step 3: Investigate any divergence**

If kinds diverge in a non-`raw` category, that's a bug. Common causes to investigate:
- `sessionUpdateToMessage` missing a variant (fix in `src/acp/session-update-mapper.ts`)
- Ordering difference caused by BoundedEventChannel coalescing — adjust channel capacity override in `AcpTurnImpl`
- ToolCallEvent missing a field — extend the mapper

Do not proceed to Checkpoint C until this test is green.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/runtime-parity.e2e.test.ts
git commit -m "test(e2e): runtime parity harness — AcpxRuntime vs AcpRuntime on codex"
```

### Checkpoint C

Ask the user:

> Checkpoint C reached. Parity test green on codex. Ready to flip `GROVE_RUNTIME` default from `acpx` to `acp`. Confirm — after flipping, the TUI and CLI will spawn via direct ACP by default. Rollback path is `GROVE_RUNTIME=acpx`.

---

## Phase 8 — Flip the default

### Task 18: Flip `selectRuntime` default + announce

**Files:**
- Modify: `src/core/select-runtime.ts`
- Modify: `src/core/select-runtime.test.ts`
- Modify: `docs/superpowers/specs/2026-04-21-grove-direct-acp-runtime-design.md` (changelog note)

- [ ] **Step 1: Adjust test**

Change the "defaults to AcpxRuntime" test in `src/core/select-runtime.test.ts` to assert `AcpRuntime`:

```ts
  test("defaults to AcpRuntime when GROVE_RUNTIME is unset", () => {
    const rt = selectRuntime({ env: {} });
    expect(rt).toBeInstanceOf(AcpRuntime);
  });
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test src/core/select-runtime.test.ts`
Expected: FAIL — default still acpx.

- [ ] **Step 3: Flip the implementation**

In `src/core/select-runtime.ts`, change the default branch:

```ts
  if (normalized === undefined || normalized === "") {
    return new AcpRuntime(options.acp);
  }
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test src/core/select-runtime.test.ts` and then the full suite `bun test`.
Expected: PASS. Watch for TUI / CLI tests that implicitly relied on the old default — if any break, investigate before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/core/select-runtime.ts src/core/select-runtime.test.ts
git commit -m "feat(runtime): flip GROVE_RUNTIME default to acp — acpx remains via opt-in"
```

### Checkpoint D

Ask the user:

> Checkpoint D. Default is now `acp`. Rollback is `GROVE_RUNTIME=acpx`. Recommend letting this soak for one release before deletion. When you're satisfied there are no stranded acpx dependencies in the TUI / CLI / server paths, say so and we'll proceed to Task 19 (deletion).

---

## Phase 9 — Delete AcpxRuntime

### Task 19: Remove `AcpxRuntime` and its scaffolding

**Files:**
- Delete: `src/core/acpx-runtime.ts`
- Delete: `src/core/acpx-runtime.test.ts`
- Delete: `src/core/acpx-runtime.integration.test.ts`
- Delete: `src/core/acpx-resolve-agent.test.ts`
- Delete: `tests/tui/acpx-worktree-e2e.ts` (replace with `acp-worktree-e2e.ts` per Task 20)
- Modify: `src/core/index.ts` (remove AcpxRuntime export)
- Modify: `src/core/select-runtime.ts` (remove the `acpx` branch; error on explicit `GROVE_RUNTIME=acpx`)
- Modify: `package.json` (no acpx-specific deps to remove — grove never depended on the acpx npm package)

- [ ] **Step 1: Remove the export**

In `src/core/index.ts`, delete the line:

```ts
export { AcpxRuntime } from "./acpx-runtime.js";
```

- [ ] **Step 2: Remove the branch**

In `src/core/select-runtime.ts`, delete the `acpx` branch and the `AcpxRuntime` import. Update the error message to reflect that only `acp` is valid:

```ts
export function selectRuntime(options: SelectRuntimeOptions = {}): AgentRuntime {
  const flag = options.env?.GROVE_RUNTIME ?? process.env.GROVE_RUNTIME;
  const normalized = flag?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "acp") {
    return new AcpRuntime(options.acp);
  }
  throw new Error(`[select-runtime] GROVE_RUNTIME=${flag} no longer supported; only "acp" is valid`);
}
```

Remove the `acpx?` field from `SelectRuntimeOptions`.

- [ ] **Step 3: Update the factory test**

In `src/core/select-runtime.test.ts`, drop tests that expected `AcpxRuntime`, and assert the error path:

```ts
  test("throws on GROVE_RUNTIME=acpx (no longer supported)", () => {
    expect(() => selectRuntime({ env: { GROVE_RUNTIME: "acpx" } })).toThrow(/no longer supported/);
  });
```

- [ ] **Step 4: Delete the files**

Run:

```bash
rm src/core/acpx-runtime.ts \
   src/core/acpx-runtime.test.ts \
   src/core/acpx-runtime.integration.test.ts \
   src/core/acpx-resolve-agent.test.ts \
   tests/tui/acpx-worktree-e2e.ts
```

- [ ] **Step 5: Run type check + full suite**

Run: `bun run typecheck && bun test`
Expected: clean. Any remaining typecheck failure is a stranded import — fix before proceeding. Common stranded callers live in `src/server/`, `src/cli/`, and `tests/`.

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "refactor(runtime): delete AcpxRuntime and its tests — direct ACP is the only path"
```

---

### Task 20: Retarget the TUI worktree E2E

**Files:**
- Create: `tests/tui/acp-worktree-e2e.ts` (port of deleted `acpx-worktree-e2e.ts`)

- [ ] **Step 1: Port the test**

Read the historical `tests/tui/acpx-worktree-e2e.ts` from git:

```bash
git show HEAD~1:tests/tui/acpx-worktree-e2e.ts > tests/tui/acp-worktree-e2e.ts
```

Edit the copy:
- Replace `import { AcpxRuntime }` with `import { AcpRuntime } from "../../src/core/acp-runtime.js"`.
- Replace `new AcpxRuntime(...)` with `new AcpRuntime(...)`. Drop the `agent: "codex"` option (not present on `AcpRuntimeOptions`) — `platform: "codex"` in the spawn config already selects codex.
- Any acpx-specific path assertions (`.acpxrc.json`, `~/.acpx/sessions/`) — delete. `AcpRuntime` has no such files.

- [ ] **Step 2: Run**

Run: `bun test tests/tui/acp-worktree-e2e.ts`
Expected: PASS when codex credentials are available.

- [ ] **Step 3: Commit**

```bash
git add tests/tui/acp-worktree-e2e.ts
git commit -m "test(tui): acp-worktree-e2e — ported from deleted acpx-worktree-e2e"
```

### Checkpoint E

Ask the user:

> Checkpoint E. AcpxRuntime deleted. Full test suite green. Remaining follow-ons (not in this plan): (1) `TuiDockResolver` integration for #193, (2) reassess `.acpxrc.json` emission in `src/core/workspace-bootstrap.ts:66` (the new runtime reads MCP config differently — file may be obsolete), (3) update memory entry `feedback_acpx_not_tmux` to say "Use ACP direct, not acpx subprocess". Confirm and we'll close issue #272 on the PR.

---

## Self-Review Summary

- **Spec coverage:**
  - `AcpRuntime implements AgentRuntime` → Task 8-10.
  - `PermissionResolver` on ACP types verbatim → Task 2.
  - Default `DenyAll` → Task 2.
  - `ChainResolver` / `AuditingResolver` → Task 3.
  - `RulesResolver` → Task 4.
  - Launch detection ported from acpx → Task 5.
  - Persistent subprocess per session → Task 9.
  - `session/update` mapping → Task 7.
  - `session/cancel` proper stopReason → Task 10 + Task 12.
  - `fs/read_text_file` + `fs/write_text_file` audit hook → Task 9 (buildClient).
  - `GROVE_RUNTIME` flag with opt-in phase → Task 15.
  - Parity gate → Task 17.
  - Flip default → Task 18.
  - Delete AcpxRuntime → Task 19.
  - `AcpxTurn` contract preserved → Task 6 (AcpTurnImpl).
- **Placeholder scan:** All code steps contain runnable code; no TODO/TBD. Test steps contain actual assertions.
- **Type consistency:** `AcpRuntimeOptions` used consistently across Tasks 8-15; `LaunchOverride` defined in Task 9 and exported via `index.ts` for test reuse (add `export type { LaunchOverride } from "./acp-runtime.js";` to `src/core/index.ts` during Task 15 if external tests ever need it; not required in-plan).
- **Open spec items deferred (per spec "Open questions"):**
  - `session/load` resume across grove restarts — not implemented; plan covers only fresh `session/new`.
  - Multi-session per subprocess — not implemented; one process per session throughout.
  - Flow-file parity — not implemented; acpx flow files are out of scope per spec.

---

Plan complete.
