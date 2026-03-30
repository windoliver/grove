/**
 * Agent topology schema and types for multi-agent coordination.
 *
 * Defines graph/tree/flat structures, roles, edges, and spawning config
 * for agent topologies within a GROVE contract.
 *
 * Wire format uses snake_case (YAML frontmatter). TypeScript uses camelCase.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod Schemas (snake_case — matches YAML frontmatter wire format)
// ---------------------------------------------------------------------------

const EdgeTypeEnum = z.enum(["delegates", "reports", "feeds", "requests", "feedback", "escalates"]);

const RoleEdgeSchema = z
  .object({
    target: z.string().min(1).max(64),
    edge_type: EdgeTypeEnum,
  })
  .strict();

const SpawningConfigSchema = z
  .object({
    dynamic: z.boolean(),
    max_depth: z.number().int().min(1).max(10).optional(),
    max_children_per_agent: z.number().int().min(1).max(20).optional(),
    timeout_seconds: z.number().int().min(10).max(3600).optional(),
  })
  .strict();

const TopologyRoleWithEdgesSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .min(1)
      .max(64),
    description: z.string().max(256).optional(),
    max_instances: z.number().int().min(1).max(100).optional(),
    edges: z.array(RoleEdgeSchema).max(50).optional(),
    command: z.string().max(512).optional(),
    // Profile fields — runtime agent configuration (boardroom)
    platform: z.enum(["claude-code", "codex", "gemini", "custom"]).optional(),
    model: z.string().max(128).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    prompt: z.string().max(4096).optional(),
    goal: z.string().max(512).optional(),
  })
  .strict();

/** Wire-format type for topology (snake_case, matches YAML). Used for isolatedDeclarations. */
interface WireAgentTopology {
  readonly structure: "graph" | "tree" | "flat";
  readonly roles: readonly {
    readonly name: string;
    readonly description?: string | undefined;
    readonly max_instances?: number | undefined;
    readonly edges?:
      | readonly {
          readonly target: string;
          readonly edge_type:
            | "delegates"
            | "reports"
            | "feeds"
            | "requests"
            | "feedback"
            | "escalates";
        }[]
      | undefined;
    readonly command?: string | undefined;
    readonly platform?: "claude-code" | "codex" | "gemini" | "custom" | undefined;
    readonly model?: string | undefined;
    readonly color?: string | undefined;
    readonly prompt?: string | undefined;
    readonly goal?: string | undefined;
  }[];
  readonly spawning?:
    | {
        readonly dynamic: boolean;
        readonly max_depth?: number | undefined;
        readonly max_children_per_agent?: number | undefined;
        readonly timeout_seconds?: number | undefined;
      }
    | undefined;
  readonly edge_types?: readonly string[] | undefined;
}

export const AgentTopologySchema: z.ZodType<WireAgentTopology> = z
  .object({
    structure: z.enum(["graph", "tree", "flat"]),
    roles: z
      .array(TopologyRoleWithEdgesSchema)
      .min(1)
      .max(50)
      .refine(
        (roles) => {
          const names = roles.map((r) => r.name);
          return new Set(names).size === names.length;
        },
        { message: "duplicate role names" },
      ),
    spawning: SpawningConfigSchema.optional(),
    edge_types: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict()
  .superRefine((topo, ctx) => {
    const roleNames = new Set(topo.roles.map((r) => r.name));

    // Validate edge targets reference defined roles and no self-edges
    for (const role of topo.roles) {
      for (const edge of role.edges ?? []) {
        if (!roleNames.has(edge.target)) {
          ctx.addIssue({
            code: "custom",
            message: `edge target '${edge.target}' is not a defined role`,
          });
        }
        if (role.name === edge.target) {
          ctx.addIssue({
            code: "custom",
            message: `role '${role.name}' has a self-edge`,
          });
        }
      }
    }

    // Flat topology must have no edges
    if (topo.structure === "flat") {
      for (const role of topo.roles) {
        if (role.edges !== undefined && role.edges.length > 0) {
          ctx.addIssue({
            code: "custom",
            message: `flat topology must not have edges (role '${role.name}' has edges)`,
          });
        }
      }
    }

    // Tree topology: each role (except one root) must have exactly one incoming edge
    if (topo.structure === "tree") {
      const incomingCount = new Map<string, number>();
      for (const name of roleNames) {
        incomingCount.set(name, 0);
      }
      for (const role of topo.roles) {
        for (const edge of role.edges ?? []) {
          const current = incomingCount.get(edge.target) ?? 0;
          incomingCount.set(edge.target, current + 1);
        }
      }

      const roots: string[] = [];
      for (const [name, count] of incomingCount) {
        if (count === 0) {
          roots.push(name);
        } else if (count > 1) {
          ctx.addIssue({
            code: "custom",
            message: `tree topology requires single parent: role '${name}' has ${count} incoming edges`,
          });
        }
      }

      if (roots.length !== 1 && topo.roles.length > 1) {
        ctx.addIssue({
          code: "custom",
          message: `tree topology must have exactly one root, found ${roots.length}: ${roots.join(", ")}`,
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// TypeScript Types (camelCase, readonly)
// ---------------------------------------------------------------------------

/** Edge type between agent roles. */
export type EdgeType = "delegates" | "reports" | "feeds" | "requests" | "feedback" | "escalates";

/** A directed edge from a role to a target role. */
export interface RoleEdge {
  readonly target: string;
  readonly edgeType: EdgeType;
}

/** Supported agent platform identifiers (boardroom). */
export type AgentPlatformType = "claude-code" | "codex" | "gemini" | "custom";

/** An agent role within a topology. */
export interface AgentRole {
  readonly name: string;
  readonly description?: string | undefined;
  readonly maxInstances?: number | undefined;
  readonly edges?: readonly RoleEdge[] | undefined;
  /** Shell command to run when spawning this role (defaults to $SHELL). */
  readonly command?: string | undefined;
  /** Agent platform identifier (boardroom). */
  readonly platform?: AgentPlatformType | undefined;
  /** Model identifier, e.g. "claude-opus-4-6" (boardroom). */
  readonly model?: string | undefined;
  /** TUI handle color as hex, e.g. "#00cccc" (boardroom). */
  readonly color?: string | undefined;
  /** System prompt / instructions for this role (up to 4096 chars). */
  readonly prompt?: string | undefined;
  /** Behavioral objective for this role (up to 512 chars). */
  readonly goal?: string | undefined;
}

/** Spawning configuration for dynamic agent creation. */
export interface SpawningConfig {
  readonly dynamic: boolean;
  readonly maxDepth?: number | undefined;
  readonly maxChildrenPerAgent?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
}

/** Agent topology defining structure, roles, edges, and spawning rules. */
export interface AgentTopology {
  readonly structure: "graph" | "tree" | "flat";
  readonly roles: readonly AgentRole[];
  readonly spawning?: SpawningConfig | undefined;
  readonly edgeTypes?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Wire format conversion (snake_case → camelCase)
// ---------------------------------------------------------------------------

/** Convert a validated snake_case wire topology to a camelCase AgentTopology. */
export function wireToTopology(wire: z.infer<typeof AgentTopologySchema>): AgentTopology {
  return {
    structure: wire.structure,
    roles: wire.roles.map(
      (role): AgentRole => ({
        name: role.name,
        ...(role.description !== undefined && { description: role.description }),
        ...(role.max_instances !== undefined && { maxInstances: role.max_instances }),
        ...(role.edges !== undefined && {
          edges: role.edges.map(
            (edge): RoleEdge => ({
              target: edge.target,
              edgeType: edge.edge_type,
            }),
          ),
        }),
        ...(role.command !== undefined && { command: role.command }),
        ...(role.platform !== undefined && { platform: role.platform as AgentPlatformType }),
        ...(role.model !== undefined && { model: role.model }),
        ...(role.color !== undefined && { color: role.color }),
        ...(role.prompt !== undefined && { prompt: role.prompt }),
        ...(role.goal !== undefined && { goal: role.goal }),
      }),
    ),
    ...(wire.spawning !== undefined && {
      spawning: wireToSpawning(wire.spawning),
    }),
    ...(wire.edge_types !== undefined && { edgeTypes: wire.edge_types }),
  };
}

function wireToSpawning(
  wire: NonNullable<z.infer<typeof AgentTopologySchema>["spawning"]>,
): SpawningConfig {
  return {
    dynamic: wire.dynamic,
    ...(wire.max_depth !== undefined && { maxDepth: wire.max_depth }),
    ...(wire.max_children_per_agent !== undefined && {
      maxChildrenPerAgent: wire.max_children_per_agent,
    }),
    ...(wire.timeout_seconds !== undefined && { timeoutSeconds: wire.timeout_seconds }),
  };
}
