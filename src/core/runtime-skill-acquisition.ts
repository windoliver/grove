import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RuntimeSkillsConfig } from "./config.js";
import type { RuntimeSkillSessionStore } from "./session.js";
import { injectSkills, SkillResolutionError } from "./skill-injector.js";

export type RuntimeSkillSource = "nexus" | "cache" | "local" | "override" | "bundled";
export type RuntimeSkillStatus = "installed" | "already_installed";
export type ProviderReloadStatus = "context-returned" | "reloaded" | "restart-required";

export type RuntimeSkillErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_AUTHORIZED"
  | "INVALID_SKILL_NAME"
  | "WORKSPACE_UNAVAILABLE"
  | "NOT_FOUND"
  | "CATALOG_UNAVAILABLE"
  | "INTEGRITY_ERROR"
  | "INSTALL_FAILED"
  | "SESSION_PERSIST_FAILED";

export interface RuntimeSkillCaller {
  readonly role: string;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly workspacePath: string;
}

export interface RuntimeSkillAcquisitionOptions {
  readonly skillName: string;
  readonly reason?: string | undefined;
  readonly caller: RuntimeSkillCaller;
}

export interface RuntimeSkillResolutionWarning {
  readonly skillName: string;
  readonly attemptedSource: string;
  readonly fallbackSource?: string | undefined;
  readonly reason: string;
}

export interface RuntimeSkillResolvedRoot {
  readonly root: string;
  readonly source: RuntimeSkillSource;
  readonly warnings: readonly RuntimeSkillResolutionWarning[];
}

export interface RuntimeSkillAcquisitionResult {
  readonly skillName: string;
  readonly status: RuntimeSkillStatus;
  readonly source: RuntimeSkillSource;
  readonly sessionPersisted: boolean;
  readonly providerReload: {
    readonly status: ProviderReloadStatus;
    readonly message: string;
  };
  readonly installedTargets: readonly string[];
  readonly skill: {
    readonly name: string;
    readonly skillMd: string;
    readonly truncated: boolean;
  };
  readonly warnings: readonly RuntimeSkillResolutionWarning[];
}

export class RuntimeSkillAcquisitionError extends Error {
  readonly code: RuntimeSkillErrorCode;
  readonly workspaceInstalled: boolean;
  readonly installedTargets: readonly string[];

  constructor(
    code: RuntimeSkillErrorCode,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly workspaceInstalled?: boolean;
      readonly installedTargets?: readonly string[];
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RuntimeSkillAcquisitionError";
    this.code = code;
    this.workspaceInstalled = options?.workspaceInstalled ?? false;
    this.installedTargets = options?.installedTargets ?? [];
  }
}

export type RuntimeSkillResolver = (
  skills: readonly string[],
) => Promise<RuntimeSkillResolvedRoot | undefined>;

export interface RuntimeSkillAcquisitionService {
  requestSkill(options: RuntimeSkillAcquisitionOptions): Promise<RuntimeSkillAcquisitionResult>;
}

export interface RuntimeSkillAcquisitionDeps {
  readonly readRuntimeSkillsConfig: () => Promise<RuntimeSkillsConfig | undefined>;
  readonly resolveSkillRoot?: RuntimeSkillResolver | undefined;
  readonly bundledSkillsRoot: string;
  readonly workspaceOverrideRoot?: string | undefined;
  readonly sessionStore?: RuntimeSkillSessionStore | undefined;
  readonly onAcquired?: ((result: RuntimeSkillAcquisitionResult) => void) | undefined;
}

function isSafeSkillName(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[/\\\0]/.test(value);
}

async function assertWorkspace(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) {
      throw new RuntimeSkillAcquisitionError(
        "WORKSPACE_UNAVAILABLE",
        `Runtime skill workspace is not a directory: ${path}`,
      );
    }
  } catch (error) {
    if (error instanceof RuntimeSkillAcquisitionError) throw error;
    throw new RuntimeSkillAcquisitionError(
      "WORKSPACE_UNAVAILABLE",
      `Runtime skill workspace is unavailable: ${path}`,
      { cause: error },
    );
  }
}

async function readBoundedText(
  path: string,
  maxBytes: number,
): Promise<{
  readonly text: string;
  readonly truncated: boolean;
}> {
  const bytes = await readFile(path);
  const truncated = bytes.byteLength > maxBytes;
  if (!truncated) {
    return { text: new TextDecoder().decode(bytes), truncated };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end > 0; end -= 1) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated };
    } catch {
      // Decrement until the byte boundary forms valid UTF-8.
    }
  }
  return { text: "", truncated };
}

function resolverErrorCode(error: unknown): "CATALOG_UNAVAILABLE" | "INTEGRITY_ERROR" {
  let current: unknown = error;
  const seen = new Set<Error>();
  for (let depth = 0; current instanceof Error && depth < 16; depth += 1) {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    if (current.name === "SkillCatalogTrustError" || current.name === "SkillBundleIntegrityError") {
      return "INTEGRITY_ERROR";
    }
    if (/(trust|integrity|signature|hash|verification)/i.test(current.message)) {
      return "INTEGRITY_ERROR";
    }
    current = current.cause;
  }
  return "CATALOG_UNAVAILABLE";
}

function relativeTargets(workspacePath: string, targets: readonly string[]): readonly string[] {
  return targets.map((target) => relative(workspacePath, target));
}

const SESSION_PERSIST_RETRY_MESSAGE =
  "Runtime skill workspace install succeeded, but session persistence failed; fix or recover session state, then retry grove_request_skill.";

export interface AvailableSkill {
  readonly name: string;
  readonly source: "bundled" | "topology";
}

/** Names of bundled skills: subdirectories of `dir` that contain a SKILL.md. */
export async function listBundledSkillNames(dir: string): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries.sort()) {
    try {
      const s = await stat(join(dir, entry));
      if (!s.isDirectory()) continue;
      const skillFile = await stat(join(dir, entry, "SKILL.md"));
      if (skillFile.isFile()) names.push(entry);
    } catch {
      // skip non-skill entries
    }
  }
  return names;
}

/** The repo-bundled skills directory (contains one subdir per skill). */
export function resolveRepoSkillsDir(): string {
  return new URL("../../skills/", import.meta.url).pathname;
}

/**
 * Available skills = bundled (from the repo skills/ dir) merged with the given
 * topology-declared skills, deduped by name (bundled wins on conflict).
 */
export async function listAvailableSkills(
  topologySkills: readonly string[] = [],
): Promise<readonly AvailableSkill[]> {
  const bundled = await listBundledSkillNames(resolveRepoSkillsDir());
  const seen = new Set<string>();
  const out: AvailableSkill[] = [];
  for (const name of bundled) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, source: "bundled" });
  }
  for (const name of topologySkills) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, source: "topology" });
  }
  return out;
}

export class DefaultRuntimeSkillAcquisitionService implements RuntimeSkillAcquisitionService {
  private readonly deps: RuntimeSkillAcquisitionDeps;

  constructor(deps: RuntimeSkillAcquisitionDeps) {
    this.deps = deps;
  }

  async requestSkill(
    options: RuntimeSkillAcquisitionOptions,
  ): Promise<RuntimeSkillAcquisitionResult> {
    const { skillName, caller } = options;
    if (!isSafeSkillName(skillName)) {
      throw new RuntimeSkillAcquisitionError(
        "INVALID_SKILL_NAME",
        `Invalid runtime skill name: ${skillName}`,
      );
    }
    await assertWorkspace(caller.workspacePath);

    const runtimeSkills = await this.deps.readRuntimeSkillsConfig();
    if (runtimeSkills === undefined) {
      throw new RuntimeSkillAcquisitionError(
        "NOT_CONFIGURED",
        "Runtime skill acquisition is not configured",
      );
    }
    const allowed = Object.hasOwn(runtimeSkills.roles, caller.role)
      ? runtimeSkills.roles[caller.role]
      : undefined;
    if (allowed === undefined || !allowed.includes(skillName)) {
      throw new RuntimeSkillAcquisitionError(
        "NOT_AUTHORIZED",
        `Role '${caller.role}' is not authorized to request skill '${skillName}'`,
      );
    }

    const nativeTargets: readonly string[] = [
      join(caller.workspacePath, ".claude", "skills", skillName),
      join(caller.workspacePath, ".codex", "skills", skillName),
    ];
    const alreadyInstalled = nativeTargets.every((target) => existsSync(join(target, "SKILL.md")));

    let resolved: RuntimeSkillResolvedRoot = {
      root: this.deps.bundledSkillsRoot,
      source: "bundled",
      warnings: [],
    };
    let preserveResolvedSource = false;
    if (this.deps.resolveSkillRoot !== undefined) {
      try {
        const resolverResult = await this.deps.resolveSkillRoot([skillName]);
        if (resolverResult !== undefined) {
          resolved = resolverResult;
          preserveResolvedSource = resolverResult.source !== "bundled";
        }
      } catch (error) {
        throw new RuntimeSkillAcquisitionError(
          resolverErrorCode(error),
          "Runtime skill catalog resolution failed",
          { cause: error },
        );
      }
    }

    let installedTargets: readonly string[] = nativeTargets;
    let actualSource = resolved.source;
    try {
      const report = await injectSkills({
        workspacePath: caller.workspacePath,
        skills: [skillName],
        bundledSkillsRoot: resolved.root,
        workspaceOverrideRoot:
          resolved.source === "bundled" ? this.deps.workspaceOverrideRoot : undefined,
      });
      installedTargets = report.injected[0]?.targets ?? installedTargets;
      const injectedSource = report.injected[0]?.source;
      if (
        !preserveResolvedSource &&
        (injectedSource === "override" || injectedSource === "bundled")
      ) {
        actualSource = injectedSource;
      }
    } catch (error) {
      if (error instanceof SkillResolutionError) {
        throw new RuntimeSkillAcquisitionError("NOT_FOUND", error.message, { cause: error });
      }
      throw new RuntimeSkillAcquisitionError(
        "INSTALL_FAILED",
        "Runtime skill installation failed",
        {
          cause: error,
        },
      );
    }

    if (caller.sessionId !== undefined && this.deps.sessionStore !== undefined) {
      let persist: Awaited<ReturnType<RuntimeSkillSessionStore["appendSessionRoleSkill"]>>;
      try {
        persist = await this.deps.sessionStore.appendSessionRoleSkill(
          caller.sessionId,
          caller.role,
          skillName,
        );
      } catch (error) {
        throw new RuntimeSkillAcquisitionError(
          "SESSION_PERSIST_FAILED",
          SESSION_PERSIST_RETRY_MESSAGE,
          {
            cause: error,
            workspaceInstalled: true,
            installedTargets: relativeTargets(caller.workspacePath, installedTargets),
          },
        );
      }
      if (persist === "session_missing" || persist === "role_missing") {
        throw new RuntimeSkillAcquisitionError(
          "SESSION_PERSIST_FAILED",
          `${SESSION_PERSIST_RETRY_MESSAGE} Persistence returned ${persist}.`,
          {
            workspaceInstalled: true,
            installedTargets: relativeTargets(caller.workspacePath, installedTargets),
          },
        );
      }
    }

    const skillPath = join(caller.workspacePath, ".codex", "skills", skillName, "SKILL.md");
    let bounded: Awaited<ReturnType<typeof readBoundedText>>;
    try {
      bounded = await readBoundedText(skillPath, runtimeSkills.returnSkillMdMaxBytes);
    } catch (error) {
      throw new RuntimeSkillAcquisitionError(
        "INSTALL_FAILED",
        "Runtime skill installation failed while reading installed SKILL.md",
        { cause: error },
      );
    }
    const result: RuntimeSkillAcquisitionResult = {
      skillName,
      status: alreadyInstalled ? "already_installed" : "installed",
      source: actualSource,
      sessionPersisted: caller.sessionId !== undefined && this.deps.sessionStore !== undefined,
      providerReload: {
        status: "context-returned",
        message: "Provider live reload is not guaranteed; use returned skill content immediately.",
      },
      installedTargets: relativeTargets(caller.workspacePath, installedTargets),
      skill: { name: skillName, skillMd: bounded.text, truncated: bounded.truncated },
      warnings: resolved.warnings,
    };
    this.deps.onAcquired?.(result);
    return result;
  }
}
