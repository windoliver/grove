import { normalizeSkillList } from "../../core/session-skill-overrides.js";

export function parseRoleSkillsInput(input: string): readonly string[] {
  if (input.trim().length === 0) {
    return [];
  }

  return normalizeSkillList(input.split(","));
}

export function formatRoleSkillsInput(skills: readonly string[]): string {
  return skills.join(", ");
}

export function setRoleSkills(
  current: ReadonlyMap<string, readonly string[]>,
  roleName: string,
  skills: readonly string[],
): Map<string, readonly string[]> {
  const next = new Map(current);
  next.set(roleName, [...skills]);
  return next;
}

export function applyRoleSkillsToAll(
  roleNames: readonly string[],
  current: ReadonlyMap<string, readonly string[]>,
  sourceRole: string,
): Map<string, readonly string[]> {
  const sourceSkills = [...(current.get(sourceRole) ?? [])];
  const next = new Map(current);

  for (const roleName of roleNames) {
    next.set(roleName, [...sourceSkills]);
  }

  return next;
}
