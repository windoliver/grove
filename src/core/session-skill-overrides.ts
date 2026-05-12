import type { AgentTopology } from "./topology.js";

export type SkillOverrideOp = "replace" | "add" | "remove";

export interface SessionSkillOverrideClause {
  readonly target: "*" | string;
  readonly op: SkillOverrideOp;
  readonly skills: readonly string[];
}

export function normalizeSkillList(skills: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawSkill of skills) {
    const skill = rawSkill.trim();
    if (skill.length === 0 || seen.has(skill)) {
      continue;
    }
    seen.add(skill);
    normalized.push(skill);
  }

  return normalized;
}

function applyClause(
  existing: readonly string[],
  clause: SessionSkillOverrideClause,
): readonly string[] {
  const clauseSkills = normalizeSkillList(clause.skills);

  switch (clause.op) {
    case "replace":
      return clauseSkills;
    case "add":
      return normalizeSkillList([...existing, ...clauseSkills]);
    case "remove": {
      const blocked = new Set(clauseSkills);
      return existing.filter((skill) => !blocked.has(skill));
    }
  }
}

export function applySessionSkillOverrides(
  topology: AgentTopology,
  clauses: readonly SessionSkillOverrideClause[],
): AgentTopology {
  const roleNames = new Set(topology.roles.map((role) => role.name));

  for (const clause of clauses) {
    if (clause.target !== "*" && !roleNames.has(clause.target)) {
      throw new Error(`Unknown role in skill override: ${clause.target}`);
    }
  }

  const blanketClauses = clauses.filter((clause) => clause.target === "*");
  const roleClauses = clauses.filter((clause) => clause.target !== "*");

  return {
    ...topology,
    roles: topology.roles.map((role) => {
      const matchingRoleClauses = roleClauses.filter((clause) => clause.target === role.name);
      const applicableClauses = [...blanketClauses, ...matchingRoleClauses];

      if (applicableClauses.length === 0) {
        return { ...role };
      }

      let nextSkills = normalizeSkillList(role.skills ?? []);
      for (const clause of applicableClauses) {
        nextSkills = applyClause(nextSkills, clause);
      }

      return {
        ...role,
        skills: [...nextSkills],
      };
    }),
  };
}
