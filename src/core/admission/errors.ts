import { GroveError } from "../errors.js";
import type { JsonValue } from "../models.js";
import type { AdmissionAudit, AdmissionRuleAudit, NormalizedAdmissionRule } from "./types.js";

export interface AdmissionRejectOptions {
  readonly ruleName: string;
  readonly ruleType: NormalizedAdmissionRule["type"];
  readonly reason: string;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
  readonly audit?: AdmissionAudit | undefined;
}

export class AdmissionRejectError extends GroveError {
  readonly ruleName: string;
  readonly ruleType: NormalizedAdmissionRule["type"];
  readonly reason: string;
  readonly evidence?: Readonly<Record<string, JsonValue>> | undefined;
  readonly audit?: AdmissionAudit | undefined;

  constructor(opts: AdmissionRejectOptions) {
    super(`Admission rejected by '${opts.ruleName}': ${opts.reason}`);
    this.name = "AdmissionRejectError";
    this.ruleName = opts.ruleName;
    this.ruleType = opts.ruleType;
    this.reason = opts.reason;
    this.evidence =
      opts.evidence === undefined ? undefined : cloneJsonRecord(opts.evidence, "evidence");
    this.audit = opts.audit === undefined ? undefined : cloneAdmissionAudit(opts.audit);
  }
}

function cloneAdmissionAudit(audit: AdmissionAudit): AdmissionAudit {
  return {
    version: audit.version,
    accepted: audit.accepted,
    evaluatedAt: audit.evaluatedAt,
    rules: audit.rules.map((rule, index) => cloneAdmissionRuleAudit(rule, index)),
    annotations: { ...audit.annotations },
  };
}

function cloneAdmissionRuleAudit(rule: AdmissionRuleAudit, index: number): AdmissionRuleAudit {
  return {
    name: rule.name,
    type: rule.type,
    accepted: rule.accepted,
    ...(rule.reason !== undefined ? { reason: rule.reason } : {}),
    ...(rule.evidence !== undefined
      ? { evidence: cloneJsonRecord(rule.evidence, `audit.rules[${index}].evidence`) }
      : {}),
  };
}

function cloneJsonRecord(
  value: Readonly<Record<string, JsonValue>>,
  path: string,
): Readonly<Record<string, JsonValue>> {
  const cloned = cloneJsonValue(value, path);
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError(`${path} must be a JSON object`);
  }
  return cloned;
}

function cloneJsonValue(value: unknown, path: string): JsonValue {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be JSON-compatible: non-finite numbers are not allowed`);
    }
    return value;
  }

  if (typeof value === "undefined") {
    throw new TypeError(`${path} must be JSON-compatible: undefined is not allowed`);
  }

  if (typeof value === "function") {
    throw new TypeError(`${path} must be JSON-compatible: functions are not allowed`);
  }

  if (typeof value === "symbol") {
    throw new TypeError(`${path} must be JSON-compatible: symbols are not allowed`);
  }

  if (typeof value === "bigint") {
    throw new TypeError(`${path} must be JSON-compatible: bigint values are not allowed`);
  }

  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    return items.map((item, index) => cloneJsonValue(item, `${path}[${index}]`));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be JSON-compatible: only plain objects are allowed`);
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} must be JSON-compatible: symbol keys are not allowed`);
  }

  const source = value as Readonly<Record<string, unknown>>;
  const cloned: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(source)) {
    cloned[key] = cloneJsonValue(child, `${path}.${key}`);
  }
  return cloned;
}
