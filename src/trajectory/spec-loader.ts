import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type {
  EventMatcher,
  GoalSpec,
  RequiredMatcher,
  RuleKind,
  RuleSpec,
  TrajectorySpec,
} from "./types.js";

const RULE_KINDS = new Set<string>([
  "precedes",
  "allowed_tools",
  "must_exist",
  "must_not_exist",
  "field_constraint",
]);

type UnknownRecord = Record<string, unknown>;

export async function loadTrajectorySpecs(paths: readonly string[]): Promise<TrajectorySpec> {
  const names: string[] = [];
  const rules: RuleSpec[] = [];
  const goals: GoalSpec[] = [];
  const ruleIds = new Set<string>();

  for (const path of paths) {
    const text = await readFile(path, "utf8");
    const root = expectRecord(YAML.parse(text), `${path}: root must be an object`);
    const name = getOptionalString(root, "name") ?? path;
    names.push(name);

    for (const rule of normalizeRules(root, path)) {
      if (ruleIds.has(rule.id)) {
        throw new Error(`duplicate rule id: ${rule.id}`);
      }
      ruleIds.add(rule.id);
      rules.push(rule);
    }

    goals.push(...normalizeGoals(root, path));
  }

  return {
    name: names.join("+"),
    sourcePaths: [...paths],
    rules,
    goals,
  };
}

function normalizeRules(root: UnknownRecord, path: string): RuleSpec[] {
  const value = root.rules;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: rules must be an array`);
  return value.map((rule, index) => normalizeRule(rule, `${path}: rules[${index}]`));
}

function normalizeRule(value: unknown, context: string): RuleSpec {
  const record = expectRecord(value, `${context} must be an object`);
  const id = expectString(record.id, `${context}.id must be a string`);
  const kind = expectRuleKind(record.kind, `${context}.kind must be a valid rule kind`);

  return {
    id,
    kind,
    ...optionalObjectField(record, "match", normalizeEventMatcher, context),
    ...optionalObjectField(record, "trigger", normalizeEventMatcher, context),
    ...optionalObjectField(record, "required", normalizeRequiredMatcher, context),
    ...optionalStringArrayField(record, "allowed", context),
    ...optionalStringField(record, "field", context),
    ...optionalPassthroughField(record, "equals"),
    ...optionalPassthroughField(record, "not_equals"),
    ...optionalStringField(record, "match_value", context),
    ...optionalStringField(record, "not_match", context),
    ...optionalBooleanField(record, "exists", context),
    ...optionalBooleanField(record, "not_exists", context),
  };
}

function normalizeGoals(root: UnknownRecord, path: string): GoalSpec[] {
  const value = root.goals;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: goals must be an array`);
  return value.map((goal, index) => normalizeGoal(goal, `${path}: goals[${index}]`));
}

function normalizeGoal(value: unknown, context: string): GoalSpec {
  const record = expectRecord(value, `${context} must be an object`);
  const id = expectString(record.id, `${context}.id must be a string`);
  const criteria = expectString(record.criteria, `${context}.criteria must be a string`);
  const evidence =
    record.evidence === undefined
      ? []
      : expectArray(record.evidence, `${context}.evidence must be an array`).map(String);
  return { id, criteria, evidence };
}

function normalizeEventMatcher(value: unknown, context: string): EventMatcher {
  const record = expectRecord(value, `${context} must be an object`);
  return {
    ...optionalStringField(record, "event", context),
    ...optionalStringField(record, "tool", context),
    ...optionalStringRecordField(record, "field_match", context),
    ...optionalStringRecordField(record, "field_not_match", context),
  };
}

function normalizeRequiredMatcher(value: unknown, context: string): RequiredMatcher {
  const matcher = normalizeEventMatcher(value, context);
  const record = expectRecord(value, `${context} must be an object`);
  return {
    ...matcher,
    ...optionalStringField(record, "match_field", context),
  };
}

function optionalObjectField<T>(
  record: UnknownRecord,
  field: string,
  normalize: (value: unknown, context: string) => T,
  context: string,
): Record<string, T> {
  if (record[field] === undefined) return {};
  return { [field]: normalize(record[field], `${context}.${field}`) };
}

function optionalStringField(
  record: UnknownRecord,
  field: string,
  context: string,
): Record<string, string> {
  if (record[field] === undefined) return {};
  return { [field]: expectString(record[field], `${context}.${field} must be a string`) };
}

function optionalBooleanField(
  record: UnknownRecord,
  field: string,
  context: string,
): Record<string, boolean> {
  if (record[field] === undefined) return {};
  return { [field]: expectBoolean(record[field], `${context}.${field} must be a boolean`) };
}

function optionalStringArrayField(
  record: UnknownRecord,
  field: string,
  context: string,
): Record<string, readonly string[]> {
  if (record[field] === undefined) return {};
  const values = expectArray(record[field], `${context}.${field} must be an array`);
  return {
    [field]: values.map((item) =>
      expectString(item, `${context}.${field} entries must be strings`),
    ),
  };
}

function optionalStringRecordField(
  record: UnknownRecord,
  field: string,
  context: string,
): Record<string, Readonly<Record<string, string>>> {
  if (record[field] === undefined) return {};
  const value = expectRecord(record[field], `${context}.${field} must be an object`);
  return {
    [field]: Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expectString(item, `${context}.${field}.${key} must be a string`),
      ]),
    ),
  };
}

function optionalPassthroughField(record: UnknownRecord, field: string): Record<string, unknown> {
  if (!Object.hasOwn(record, field)) return {};
  return { [field]: record[field] };
}

function expectRecord(value: unknown, message: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as UnknownRecord;
}

function expectArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value;
}

function expectString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function getOptionalString(record: UnknownRecord, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : undefined;
}

function expectBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw new Error(message);
  return value;
}

function expectRuleKind(value: unknown, message: string): RuleKind {
  if (typeof value !== "string" || !RULE_KINDS.has(value)) throw new Error(message);
  return value as RuleKind;
}
