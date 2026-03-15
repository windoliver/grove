/**
 * Agent profile types and overlay loading.
 *
 * Agent profiles extend topology roles with runtime configuration:
 * platform, model, color, MCP toggles, and ask-user settings.
 *
 * Profiles are stored in `.grove/agents.json` and validated against
 * the contract topology roles. A profile without a matching contract
 * role is a validation error.
 *
 * Wire format uses snake_case (JSON file). TypeScript uses camelCase.
 */

import { z } from "zod";

import type { AgentTopology } from "./topology.js";

// ---------------------------------------------------------------------------
// Zod Schemas (snake_case — matches JSON wire format)
// ---------------------------------------------------------------------------

/** Supported agent platforms. */
const AgentPlatformEnum = z.enum(["claude-code", "codex", "gemini", "custom"]);

const AgentProfileWireSchema = z
  .object({
    name: z
      .string()
      .regex(/^@[a-z][a-z0-9_-]*$/)
      .min(2)
      .max(64),
    role: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .min(1)
      .max(64),
    platform: AgentPlatformEnum,
    command: z.string().max(512).optional(),
    model: z.string().max(128).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    mcp_servers: z.array(z.string().min(1).max(128)).max(20).optional(),
    ask_user_enabled: z.boolean().optional(),
  })
  .strict();

const AgentProfilesFileSchema = z
  .object({
    profiles: z.array(AgentProfileWireSchema).max(50),
  })
  .strict();

// ---------------------------------------------------------------------------
// TypeScript Types (camelCase, readonly)
// ---------------------------------------------------------------------------

/** Supported agent platform identifiers. */
export type AgentPlatform = "claude-code" | "codex" | "gemini" | "custom";

/** Runtime agent profile — extends a topology role with platform details. */
export interface AgentProfile {
  /** Display name with @ prefix, e.g. "@claude-eng". */
  readonly name: string;
  /** Maps to a topology role name. */
  readonly role: string;
  /** Agent platform identifier. */
  readonly platform: AgentPlatform;
  /** Shell command to run when spawning (overrides role command). */
  readonly command?: string | undefined;
  /** Model identifier, e.g. "claude-opus-4-6". */
  readonly model?: string | undefined;
  /** TUI handle color as hex, e.g. "#00cccc". */
  readonly color?: string | undefined;
  /** MCP servers to enable for this agent. */
  readonly mcpServers?: readonly string[] | undefined;
  /** Whether ask-user is active for this agent. */
  readonly askUserEnabled?: boolean | undefined;
}

/** Parsed agents.json file content. */
export interface AgentProfilesFile {
  readonly profiles: readonly AgentProfile[];
}

// ---------------------------------------------------------------------------
// Wire format conversion
// ---------------------------------------------------------------------------

function wireToProfile(wire: z.infer<typeof AgentProfileWireSchema>): AgentProfile {
  return {
    name: wire.name,
    role: wire.role,
    platform: wire.platform as AgentPlatform,
    ...(wire.command !== undefined && { command: wire.command }),
    ...(wire.model !== undefined && { model: wire.model }),
    ...(wire.color !== undefined && { color: wire.color }),
    ...(wire.mcp_servers !== undefined && { mcpServers: wire.mcp_servers }),
    ...(wire.ask_user_enabled !== undefined && { askUserEnabled: wire.ask_user_enabled }),
  };
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate an agents.json file content.
 *
 * @throws {Error} if JSON is invalid or schema validation fails.
 */
export function parseAgentProfiles(json: string): AgentProfilesFile {
  const raw: unknown = JSON.parse(json);
  const result = AgentProfilesFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid agents.json: ${issues}`);
  }
  return {
    profiles: result.data.profiles.map(wireToProfile),
  };
}

/**
 * Validate agent profiles against a contract topology.
 *
 * Ensures:
 * - Every profile references a defined role
 * - No duplicate profile names
 * - No duplicate role assignments beyond maxInstances
 *
 * @throws {Error} if validation fails.
 */
export function validateProfilesAgainstTopology(
  profiles: readonly AgentProfile[],
  topology: AgentTopology | undefined,
): void {
  const errors: string[] = [];

  // Check for duplicate names
  const names = new Set<string>();
  for (const p of profiles) {
    if (names.has(p.name)) {
      errors.push(`duplicate profile name '${p.name}'`);
    }
    names.add(p.name);
  }

  // Validate role references
  if (topology !== undefined) {
    const roleNames = new Set(topology.roles.map((r) => r.name));
    const roleCounts = new Map<string, number>();

    for (const p of profiles) {
      if (!roleNames.has(p.role)) {
        errors.push(`profile '${p.name}' references undefined role '${p.role}'`);
        continue;
      }
      roleCounts.set(p.role, (roleCounts.get(p.role) ?? 0) + 1);
    }

    // Check maxInstances
    for (const role of topology.roles) {
      if (role.maxInstances !== undefined) {
        const count = roleCounts.get(role.name) ?? 0;
        if (count > role.maxInstances) {
          errors.push(
            `role '${role.name}' has ${count} profiles but maxInstances is ${role.maxInstances}`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid agent profiles: ${errors.join("; ")}`);
  }
}

/**
 * Serialize agent profiles to JSON for writing to agents.json.
 */
export function serializeAgentProfiles(profiles: readonly AgentProfile[]): string {
  const wire = {
    profiles: profiles.map((p) => ({
      name: p.name,
      role: p.role,
      platform: p.platform,
      ...(p.command !== undefined && { command: p.command }),
      ...(p.model !== undefined && { model: p.model }),
      ...(p.color !== undefined && { color: p.color }),
      ...(p.mcpServers !== undefined && { mcp_servers: [...p.mcpServers] }),
      ...(p.askUserEnabled !== undefined && { ask_user_enabled: p.askUserEnabled }),
    })),
  };
  return JSON.stringify(wire, null, 2);
}
