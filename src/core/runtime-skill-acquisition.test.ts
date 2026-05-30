import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSkillsConfig } from "./config.js";
import type { RuntimeSkillResolver } from "./runtime-skill-acquisition.js";
import {
  DefaultRuntimeSkillAcquisitionService,
  listAvailableSkills,
  listBundledSkillNames,
  RuntimeSkillAcquisitionError,
} from "./runtime-skill-acquisition.js";
import type { RuntimeSkillSessionStore } from "./session.js";

let root: string;
let workspace: string;
let catalogRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "grove-runtime-skills-"));
  workspace = join(root, "workspace");
  catalogRoot = join(root, "catalog");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(catalogRoot, "review"), { recursive: true });
  writeFileSync(join(catalogRoot, "review", "SKILL.md"), "review skill", "utf-8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(overrides: Partial<RuntimeSkillsConfig> = {}): RuntimeSkillsConfig {
  return {
    mode: "role-allowlist",
    roles: { coder: ["review"] },
    returnSkillMdMaxBytes: 65536,
    ...overrides,
  };
}

function service(
  opts: {
    runtimeSkills?: RuntimeSkillsConfig | undefined;
    resolveSkillRoot?: RuntimeSkillResolver | undefined;
    sessionStore?: RuntimeSkillSessionStore | undefined;
  } = {},
): DefaultRuntimeSkillAcquisitionService {
  return new DefaultRuntimeSkillAcquisitionService({
    readRuntimeSkillsConfig: async () => opts.runtimeSkills,
    resolveSkillRoot:
      opts.resolveSkillRoot ??
      (async () => ({ root: catalogRoot, source: "bundled", warnings: [] })),
    bundledSkillsRoot: catalogRoot,
    sessionStore: opts.sessionStore,
  });
}

describe("DefaultRuntimeSkillAcquisitionService", () => {
  test("denies when runtime skills are not configured", async () => {
    await expect(
      service().requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  test("denies skills not allowlisted for role", async () => {
    await expect(
      service({ runtimeSkills: config() }).requestSkill({
        skillName: "grove",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  test("denies prototype-colliding roles not present in allowlist", async () => {
    await expect(
      service({ runtimeSkills: config() }).requestSkill({
        skillName: "review",
        caller: { role: "toString", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
  });

  test("rejects unsafe skill names before resolver call", async () => {
    let resolverCalls = 0;

    await expect(
      service({
        runtimeSkills: config(),
        resolveSkillRoot: async () => {
          resolverCalls += 1;
          return { root: catalogRoot, source: "bundled", warnings: [] };
        },
      }).requestSkill({
        skillName: "../review",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_SKILL_NAME" });
    expect(resolverCalls).toBe(0);
  });

  test("installs skill, returns content, and persists session role skill", async () => {
    const calls: Array<[string, string, string]> = [];
    const sessionStore: RuntimeSkillSessionStore = {
      appendSessionRoleSkill: async (sessionId, roleName, skillName) => {
        calls.push([sessionId, roleName, skillName]);
        return "appended";
      },
    };

    const result = await service({ runtimeSkills: config(), sessionStore }).requestSkill({
      skillName: "review",
      reason: "Need review instructions",
      caller: { role: "coder", agentId: "agent-1", workspacePath: workspace, sessionId: "s1" },
    });

    expect(result.status).toBe("installed");
    expect(result.skill.skillMd).toBe("review skill");
    expect(result.sessionPersisted).toBe(true);
    expect(calls).toEqual([["s1", "coder", "review"]]);
    expect(readFileSync(join(workspace, ".codex/skills/review/SKILL.md"), "utf-8")).toBe(
      "review skill",
    );
  });

  test("truncates returned skill content by configured byte limit", async () => {
    writeFileSync(join(catalogRoot, "review", "SKILL.md"), "1234567890", "utf-8");

    const result = await service({
      runtimeSkills: config({ returnSkillMdMaxBytes: 4 }),
    }).requestSkill({
      skillName: "review",
      caller: { role: "coder", workspacePath: workspace },
    });

    expect(result.skill.skillMd).toBe("1234");
    expect(result.skill.truncated).toBe(true);
  });

  test("truncates returned multibyte content at valid utf-8 boundary", async () => {
    writeFileSync(join(catalogRoot, "review", "SKILL.md"), "ééé", "utf-8");

    const result = await service({
      runtimeSkills: config({ returnSkillMdMaxBytes: 3 }),
    }).requestSkill({
      skillName: "review",
      caller: { role: "coder", workspacePath: workspace },
    });

    expect(result.skill.skillMd).not.toContain("\uFFFD");
    expect(new TextEncoder().encode(result.skill.skillMd).byteLength).toBeLessThanOrEqual(3);
    expect(result.skill.truncated).toBe(true);
  });

  test("preserves resolver source metadata and warnings", async () => {
    const warnings = [
      {
        skillName: "review",
        attemptedSource: "nexus",
        fallbackSource: "bundled",
        reason: "used signed catalog root",
      },
    ];

    const result = await service({
      runtimeSkills: config(),
      resolveSkillRoot: async () => ({ root: catalogRoot, source: "nexus", warnings }),
    }).requestSkill({
      skillName: "review",
      caller: { role: "coder", workspacePath: workspace },
    });

    expect(result.source).toBe("nexus");
    expect(result.warnings).toEqual(warnings);
  });

  test("returns already_installed when both native targets exist", async () => {
    mkdirSync(join(workspace, ".codex", "skills", "review"), { recursive: true });
    mkdirSync(join(workspace, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(join(workspace, ".codex", "skills", "review", "SKILL.md"), "installed", "utf-8");
    writeFileSync(join(workspace, ".claude", "skills", "review", "SKILL.md"), "installed", "utf-8");

    const result = await service({ runtimeSkills: config() }).requestSkill({
      skillName: "review",
      caller: { role: "coder", workspacePath: workspace },
    });

    expect(result.status).toBe("already_installed");
    expect(result.skill.skillMd).toBe("review skill");
  });

  test("re-resolves and refreshes preinstalled skills before returning content", async () => {
    mkdirSync(join(workspace, ".codex", "skills", "review"), { recursive: true });
    mkdirSync(join(workspace, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(join(workspace, ".codex", "skills", "review", "SKILL.md"), "stale", "utf-8");
    writeFileSync(join(workspace, ".claude", "skills", "review", "SKILL.md"), "stale", "utf-8");

    let resolverCalls = 0;
    const result = await service({
      runtimeSkills: config(),
      resolveSkillRoot: async () => {
        resolverCalls += 1;
        return { root: catalogRoot, source: "nexus", warnings: [] };
      },
    }).requestSkill({
      skillName: "review",
      caller: { role: "coder", workspacePath: workspace },
    });

    expect(resolverCalls).toBe(1);
    expect(result.status).toBe("already_installed");
    expect(result.source).toBe("nexus");
    expect(result.skill.skillMd).toBe("review skill");
    expect(readFileSync(join(workspace, ".codex/skills/review/SKILL.md"), "utf-8")).toBe(
      "review skill",
    );
  });

  test("maps unreadable installed skill content to install failure", async () => {
    mkdirSync(join(workspace, ".codex", "skills", "review", "SKILL.md"), { recursive: true });
    mkdirSync(join(workspace, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(join(workspace, ".claude", "skills", "review", "SKILL.md"), "installed", "utf-8");

    await expect(
      service({ runtimeSkills: config() }).requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace },
      }),
    ).rejects.toMatchObject({ code: "INSTALL_FAILED" });
  });

  test("reports retry-safe persistence failure after install", async () => {
    const sessionStore: RuntimeSkillSessionStore = {
      appendSessionRoleSkill: async () => "role_missing",
    };

    await expect(
      service({ runtimeSkills: config(), sessionStore }).requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      }),
    ).rejects.toMatchObject({
      code: "SESSION_PERSIST_FAILED",
      message: expect.stringContaining("retry grove_request_skill"),
      workspaceInstalled: true,
    });
  });

  test("wraps thrown session persistence failure after install", async () => {
    const cause = new Error("session store unavailable");
    const sessionStore: RuntimeSkillSessionStore = {
      appendSessionRoleSkill: async () => {
        throw cause;
      },
    };

    try {
      await service({ runtimeSkills: config(), sessionStore }).requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace, sessionId: "s1" },
      });
      throw new Error("expected requestSkill to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeSkillAcquisitionError);
      if (!(error instanceof RuntimeSkillAcquisitionError)) {
        throw error;
      }
      expect(error.code).toBe("SESSION_PERSIST_FAILED");
      expect(error.message).toContain("retry grove_request_skill");
      expect(error.workspaceInstalled).toBe(true);
      expect(error.installedTargets).toEqual([".claude/skills/review", ".codex/skills/review"]);
      expect(error.cause).toBe(cause);
    }
    expect(readFileSync(join(workspace, ".codex/skills/review/SKILL.md"), "utf-8")).toBe(
      "review skill",
    );
  });

  test("maps resolver availability failures to catalog unavailable", async () => {
    await expect(
      service({
        runtimeSkills: config(),
        resolveSkillRoot: async () => {
          throw new Error("catalog offline");
        },
      }).requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
  });

  test("maps resolver trust failures to integrity errors", async () => {
    const error = new Error("signature verification failed");
    error.name = "SkillCatalogTrustError";

    await expect(
      service({
        runtimeSkills: config(),
        resolveSkillRoot: async () => {
          throw error;
        },
      }).requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace },
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  test("maps wrapped resolver integrity failures to integrity errors", async () => {
    const cause = new Error("bundle hash mismatch");
    cause.name = "SkillBundleIntegrityError";
    const error = new Error("catalog unavailable", { cause });
    error.name = "SkillCatalogUnavailableError";

    await expect(
      service({
        runtimeSkills: config(),
        resolveSkillRoot: async () => {
          throw error;
        },
      }).requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace },
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  test("maps cyclic resolver causes to catalog unavailable without hanging", async () => {
    const error = new Error("catalog unavailable");
    Object.defineProperty(error, "cause", {
      configurable: true,
      value: error,
    });

    await expect(
      service({
        runtimeSkills: config(),
        resolveSkillRoot: async () => {
          throw error;
        },
      }).requestSkill({
        skillName: "review",
        caller: { role: "coder", workspacePath: workspace },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
  });
});

describe("listAvailableSkills (#275)", () => {
  test("includes the bundled grove skill", async () => {
    const skills = await listAvailableSkills();
    expect(skills.map((s) => s.name)).toContain("grove");
    expect(skills.find((s) => s.name === "grove")?.source).toBe("bundled");
  });
  test("merges topology skills and dedupes (bundled wins)", async () => {
    const skills = await listAvailableSkills(["custom-role-skill", "grove"]);
    const names = skills.map((s) => s.name);
    expect(names).toContain("custom-role-skill");
    expect(names.filter((n) => n === "grove").length).toBe(1); // deduped
    expect(skills.find((s) => s.name === "custom-role-skill")?.source).toBe("topology");
  });
  test("listBundledSkillNames returns [] for a missing dir", async () => {
    expect(await listBundledSkillNames("/no/such/dir")).toEqual([]);
  });
});
