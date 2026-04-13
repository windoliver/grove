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

const EdgeTypeEnum = z.enum([
  "delegates", // Forward work: source produces, target acts on it
  "feedback",  // Response: target sends results back to source
  "monitors",  // Observe-only: source watches target
  // Legacy aliases — mapped to delegates at parse time for backward compat
  "reports",
  "feeds",
  "requests",
  "escalates",
]);

const WorkspaceStrategyEnum = z.enum(["branch_from_source", "independent"]);

const RoleEdgeSchema = z
  .object({
    target: z.string().min(1).max(64),
    edge_type: EdgeTypeEnum,
    workspace: WorkspaceStrategyEnum.optional(),
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
            | "feedback"
            | "monitors"
            | "reports"
            | "feeds"
            | "requests"
            | "escalates";
          readonly workspace?: "branch_from_source" | "independent" | undefined;
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

/**
 * Edge type between agent roles.
 *
 * Core types:
 *   delegates — forward work: source produces, target acts on it
 *   feedback  — response: target sends results back to source
 *   monitors  — observe-only: source watches target without producing
 *
 * Legacy aliases (mapped to delegates): reports, feeds, requests, escalates
 */
export type EdgeType =
  | "delegates"
  | "feedback"
  | "monitors"
  // Legacy — kept for backward compat with existing GROVE.md files
  | "reports"
  | "feeds"
  | "requests"
  | "escalates";

/**
 * Workspace strategy for an edge — controls whether the target role's worktree
 * branches off the source role's branch or starts fresh from HEAD.
 *
 * - `branch_from_source`: target's worktree is based on the source's grove branch.
 *   Target can `git merge grove/<session>/<source>` to pick up source's commits.
 * - `independent` (default): target's worktree starts from HEAD. No branch relationship.
 */
export type WorkspaceStrategy = "branch_from_source" | "independent";

/**
 * Resolve the git base branch for each role's worktree.
 *
 * Only edges with explicit `workspace: "branch_from_source"` create a branch
 * dependency. All other edges (and the default) use HEAD.
 *
 * Returns a Map<roleName, baseBranch> where baseBranch is either "HEAD" or
 * "grove/<sessionId>/<sourceRole>".
 */
export function resolveRoleWorkspaceStrategies(
  topology: AgentTopology,
  sessionId: string,
): Map<string, string> {
  const strategies = new Map<string, string>(topology.roles.map((r) => [r.name, "HEAD"]));

  for (const role of topology.roles) {
    for (const edge of role.edges ?? []) {
      if (edge.workspace === "branch_from_source") {
        strategies.set(edge.target, `grove/${sessionId}/${role.name}`);
      }
    }
  }

  return strategies;
}

/**
 * Topologically sort roles so that source roles are provisioned before
 * their dependents (which need the source's git branch to exist).
 *
 * Only edges with `workspace: "branch_from_source"` create ordering
 * constraints. Uses Kahn's algorithm. Falls back to the original role
 * order if a cycle is detected.
 */
export function topologicalSortRoles(topology: AgentTopology): readonly AgentRole[] {
  const roles = topology.roles;
  const roleByName = new Map(roles.map((r) => [r.name, r]));

  // Build reverse dependency map: role → set of roles that must come before it
  const deps = new Map<string, Set<string>>(roles.map((r) => [r.name, new Set()]));
  for (const role of roles) {
    for (const edge of role.edges ?? []) {
      if (edge.workspace === "branch_from_source") {
        deps.get(edge.target)?.add(role.name);
      }
    }
  }

  // Kahn's algorithm: start from roles with no dependencies
  const inDegree = new Map<string, number>(roles.map((r) => [r.name, deps.get(r.name)?.size ?? 0]));
  const queue = roles.filter((r) => (inDegree.get(r.name) ?? 0) === 0);
  const sorted: AgentRole[] = [];

  while (queue.length > 0) {
    const role = queue.shift()!;
    sorted.push(role);
    // Reduce in-degree for all roles that depended on this one
    for (const [name, depSet] of deps) {
      if (depSet.has(role.name)) {
        const newDegree = (inDegree.get(name) ?? 1) - 1;
        inDegree.set(name, newDegree);
        if (newDegree === 0) {
          const r = roleByName.get(name);
          if (r) queue.push(r);
        }
      }
    }
  }

  // Cycle detected — fall back to original order
  return sorted.length === roles.length ? sorted : [...roles];
}

/** A directed edge from a role to a target role. */
export interface RoleEdge {
  readonly target: string;
  readonly edgeType: EdgeType;
  /** Workspace strategy — default: independent (HEAD). */
  readonly workspace?: WorkspaceStrategy | undefined;
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
              ...(edge.workspace !== undefined && { workspace: edge.workspace }),
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
