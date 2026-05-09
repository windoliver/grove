import {
  applySessionSkillOverrides,
  type SessionSkillOverrideClause,
} from "../../core/session-skill-overrides.js";
import type { AgentTopology } from "../../core/topology.js";
import {
  type PresetLookup,
  resolveTopology,
  type TopologyResolutionResult,
} from "../../core/topology-resolver.js";

interface SessionStartTopologyInput {
  readonly rolesArg?: string | undefined;
  readonly presetName?: string | undefined;
  readonly contractDefault?: AgentTopology | undefined;
  readonly skillArgs: readonly string[];
}

function parseClause(raw: string): SessionSkillOverrideClause {
  const clause = raw.trim();
  const operators = [
    { token: "+=", op: "add" },
    { token: "-=", op: "remove" },
    { token: "=", op: "replace" },
  ] as const;

  for (const { token, op } of operators) {
    const tokenIndex = clause.indexOf(token);
    if (tokenIndex === -1) {
      continue;
    }

    const target = clause.slice(0, tokenIndex).trim();
    const rhs = clause.slice(tokenIndex + token.length).trim();

    if (target.length === 0) {
      throw new Error(`Invalid --skills clause: ${raw}`);
    }

    if ((op === "add" || op === "remove") && rhs.length === 0) {
      throw new Error(`Invalid --skills clause: ${raw}`);
    }

    const skills =
      rhs.length === 0
        ? []
        : rhs
            .split(",")
            .map((skill) => skill.trim())
            .filter((skill) => skill.length > 0);

    if (rhs.length > 0 && skills.length === 0) {
      throw new Error(`Invalid --skills clause: ${raw}`);
    }

    return { target, op, skills };
  }

  throw new Error(`Invalid --skills clause: ${raw}`);
}

export function parseSessionSkillOverrideClauses(
  rawValues: readonly string[],
): readonly SessionSkillOverrideClause[] {
  return rawValues.map((rawValue) => parseClause(rawValue));
}

function buildInlineTopologyFromRolesArg(rolesArg?: string | undefined): AgentTopology | undefined {
  if (rolesArg === undefined) {
    return undefined;
  }

  const roleNames = rolesArg
    .split(",")
    .map((roleName) => roleName.trim())
    .filter((roleName) => roleName.length > 0);

  if (roleNames.length === 0) {
    throw new Error("--roles must be a comma-separated list of role names");
  }

  return {
    structure: "flat",
    roles: roleNames.map((name) => ({
      name,
      description: `Agent role: ${name}`,
      platform: "claude-code" as const,
    })),
  };
}

export function resolveSessionStartTopology(
  input: SessionStartTopologyInput,
  lookupPreset?: PresetLookup,
): TopologyResolutionResult {
  const inlineTopology = buildInlineTopologyFromRolesArg(input.rolesArg);
  const resolution = resolveTopology(
    {
      inlineTopology,
      presetName: input.presetName,
      contractDefault: input.contractDefault,
    },
    lookupPreset,
  );

  if (!resolution.ok) {
    return resolution;
  }

  const clauses = parseSessionSkillOverrideClauses(input.skillArgs);
  if (clauses.length === 0) {
    return resolution;
  }

  return {
    ok: true,
    topology: applySessionSkillOverrides(resolution.topology, clauses),
    source: resolution.source,
  };
}
