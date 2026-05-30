import { describe, expect, test } from "bun:test";
import {
  delegateSource,
  killSource,
  promptSource,
  sessionNavSource,
  skillSource,
  spawnSource,
} from "./dynamic-sources.js";
import { buildSlashIndex, resolveSlash } from "./slash-index.js";
import type { ActionContext } from "./types.js";

const baseCtx = (over: Partial<ActionContext>): ActionContext =>
  ({
    sessions: [],
    profiles: [],
    gossipPeers: [],
    claims: [],
    mcpPrompts: [],
    availableSkills: [],
    pendingQuestionCount: 0,
    hasGoals: false,
    canSpawn: true,
    canDelegate: false,
    isPanelVisible: () => false,
    focusedPanel: 0,
    frontierSliceCount: 0,
    runPrompt: () => {
      /* noop */
    },
    requestSkill: () => {
      /* noop */
    },
    ...over,
  }) as ActionContext;

describe("dynamic sources", () => {
  test("sessionNavSource emits one nav action per session", () => {
    expect(sessionNavSource(baseCtx({ sessions: ["s1", "s2"] })).map((a) => a.id)).toEqual([
      "nav.session.s1",
      "nav.session.s2",
    ]);
  });

  test("killSource emits one kill action per session", () => {
    expect(killSource(baseCtx({ sessions: ["s1"] })).map((a) => a.id)).toEqual(["agent.kill.s1"]);
  });

  test("spawnSource is empty when canSpawn is false", () => {
    expect(spawnSource(baseCtx({ canSpawn: false, profiles: [] }))).toEqual([]);
  });

  test("delegateSource skips peers with no free slots", () => {
    const ctx = baseCtx({
      canDelegate: true,
      gossipPeers: [
        { peerId: "p1", address: "a1", freeSlots: 0 },
        { peerId: "p2", address: "a2", freeSlots: 2 },
      ],
    });
    expect(delegateSource(ctx).map((a) => a.id)).toEqual(["agent.delegate.a2"]);
  });

  // --- moved from builtin-actions.test.ts (per-entity assertions) ---

  test("spawn from profile is present but enabled at capacity check", () => {
    const ctx = baseCtx({
      canSpawn: true,
      profiles: [{ name: "@rev", role: "reviewer", platform: "claude-code" }],
    });
    const spawn = spawnSource(ctx).find((a) => a.id === "agent.spawn.reviewer");
    expect(spawn).toBeDefined();
    expect(spawn?.enabled?.(ctx) ?? true).toBe(true);
  });

  test("spawn detail shows capacity and edges from topology", () => {
    const topology = {
      roles: [
        { name: "planner", maxInstances: 3, edges: [{ target: "reviewer" }] },
        { name: "reviewer", maxInstances: 1 },
      ],
    } as unknown as ActionContext["topology"];
    const ctx = baseCtx({ canSpawn: true, topology, claims: [] });
    const planner = spawnSource(ctx).find((a) => a.id === "agent.spawn.planner");
    expect(planner?.detail).toBe("0/3 → reviewer");
    const reviewer = spawnSource(ctx).find((a) => a.id === "agent.spawn.reviewer");
    expect(reviewer?.detail).toBe("0/1");
  });

  test("spawn detail falls back to 'spawn' without topology", () => {
    const ctx = baseCtx({
      canSpawn: true,
      profiles: [{ name: "@w", role: "worker", platform: "claude-code" }],
    });
    const spawn = spawnSource(ctx).find((a) => a.id === "agent.spawn.worker");
    expect(spawn?.detail).toBe("spawn");
  });

  test("delegate only available when canDelegate and peer has free slots", () => {
    const peers = [{ peerId: "p1", address: "http://p1", freeSlots: 2 }];
    const notDelegating = baseCtx({ canDelegate: false, gossipPeers: peers });
    const delegate = delegateSource(notDelegating).find((a) => a.id === "agent.delegate.http://p1");
    expect(delegate).toBeDefined();
    expect(delegate?.available?.(notDelegating) ?? true).toBe(false);

    const delegating = baseCtx({ canDelegate: true, gossipPeers: peers });
    const delegate2 = delegateSource(delegating).find((a) => a.id === "agent.delegate.http://p1");
    expect(delegate2?.available?.(delegating) ?? true).toBe(true);
  });

  test("promptSource emits a Prompts-group action per prompt, gated on selected session", () => {
    const withSession = baseCtx({
      selectedSession: "s1",
      mcpPrompts: [{ name: "triage", description: "Triage", template: "do triage" }],
    });
    const actions = promptSource(withSession);
    expect(actions.map((a) => a.id)).toEqual(["prompt.triage"]);
    expect(actions[0]?.group).toBe("Prompts");
    // available is false without a selected session
    const noSession = baseCtx({ mcpPrompts: [{ name: "triage", template: "x" }] });
    expect(actions[0]?.available?.(noSession)).toBe(false);
  });

  test("promptSource run delivers the template to the selected session", () => {
    let delivered: { text: string; session: string } | undefined;
    const ctx = baseCtx({
      selectedSession: "s1",
      mcpPrompts: [{ name: "triage", template: "do triage" }],
      runPrompt: (text: string, session: string) => {
        delivered = { text, session };
      },
    });
    promptSource(ctx)[0]?.run(ctx);
    expect(delivered).toEqual({ text: "do triage", session: "s1" });
  });

  test("skillSource scopes to the selected agent's role skills", () => {
    const ctx = baseCtx({
      selectedSession: "s1",
      selectedAgentRole: "reviewer",
      availableSkills: [
        { name: "code-review", roles: ["reviewer"] },
        { name: "writing", roles: ["author"] },
      ],
    });
    expect(skillSource(ctx).map((a) => a.id)).toEqual(["skill.request.code-review"]);
    expect(skillSource(ctx)[0]?.group).toBe("Skills");
  });

  test("skillSource includes role-less (global) skills", () => {
    const ctx = baseCtx({
      selectedSession: "s1",
      selectedAgentRole: "reviewer",
      availableSkills: [{ name: "grove" }],
    });
    expect(skillSource(ctx).map((a) => a.id)).toEqual(["skill.request.grove"]);
  });

  test("skillSource uses the colon slash form so it resolves via the ':' command-line", () => {
    const ctx = baseCtx({
      selectedSession: "s1",
      availableSkills: [{ name: "grove" }],
    });
    expect(skillSource(ctx)[0]?.slash).toBe("/skill:grove");
  });

  test("colon-form skill slash is resolvable via the command-line index", () => {
    const ctx = baseCtx({
      selectedSession: "s1",
      availableSkills: [{ name: "grove" }],
    });
    const index = buildSlashIndex(skillSource(ctx));
    expect(resolveSlash(index, "/skill:grove")).toEqual({
      id: "skill.request.grove",
      args: [],
    });
  });

  test("skillSource is empty without a selected session", () => {
    expect(skillSource(baseCtx({ availableSkills: [{ name: "x" }] }))).toEqual([]);
  });

  test("skillSource run requests the skill for the selected session", () => {
    let req: { name: string; session: string } | undefined;
    const ctx = baseCtx({
      selectedSession: "s1",
      availableSkills: [{ name: "grove" }],
      requestSkill: (name: string, session: string) => {
        req = { name, session };
      },
    });
    skillSource(ctx)[0]?.run(ctx);
    expect(req).toEqual({ name: "grove", session: "s1" });
  });

  test("two profiles sharing a role produce a single (de-duped) spawn action", () => {
    const ctx = baseCtx({
      canSpawn: true,
      profiles: [
        { name: "@a", role: "reviewer", platform: "claude-code" },
        { name: "@b", role: "reviewer", platform: "codex" },
      ],
    });
    const spawnIds = spawnSource(ctx)
      .map((a) => a.id)
      .filter((id) => id === "agent.spawn.reviewer");
    expect(spawnIds).toHaveLength(1);
  });
});
