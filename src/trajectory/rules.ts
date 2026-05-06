import { fieldValue, matchesEvent, patternMatches, valuesEqual } from "./match.js";
import type {
  EventMatcher,
  RequiredMatcher,
  RuleResult,
  RuleSpec,
  RuleViolation,
  TrajectoryEvent,
  TranscriptIndex,
} from "./types.js";
import { formatSeq, TrajectoryEventType } from "./types.js";

export function evaluateRules(
  index: TranscriptIndex,
  rules: readonly RuleSpec[],
): readonly RuleResult[] {
  return rules.map((rule) => evaluateRule(index.events, rule));
}

function evaluateRule(events: readonly TrajectoryEvent[], rule: RuleSpec): RuleResult {
  switch (rule.kind) {
    case "must_exist":
      return evaluateMustExist(events, rule);
    case "must_not_exist":
      return evaluateMustNotExist(events, rule);
    case "allowed_tools":
      return evaluateAllowedTools(events, rule);
    case "field_constraint":
      return evaluateFieldConstraint(events, rule);
    case "precedes":
      return evaluatePrecedes(events, rule);
  }
}

function evaluateMustExist(events: readonly TrajectoryEvent[], rule: RuleSpec): RuleResult {
  const found = events.some((item) => matchesOptionalRule(item, rule.match));
  if (found) return pass(rule);

  return fail(rule, [
    {
      ruleId: rule.id,
      message: `Rule ${rule.id} requires at least one matching event.`,
    },
  ]);
}

function evaluateMustNotExist(events: readonly TrajectoryEvent[], rule: RuleSpec): RuleResult {
  const violations = events
    .filter((item) => matchesOptionalRule(item, rule.match))
    .map((item) =>
      eventViolation(rule, item, `Rule ${rule.id} forbids matching event ${formatSeq(item.seq)}.`),
    );

  return result(rule, violations);
}

function evaluateAllowedTools(events: readonly TrajectoryEvent[], rule: RuleSpec): RuleResult {
  const allowed = rule.allowed;
  if (allowed === undefined) {
    return configError(rule, "allowed_tools rule requires an allowed list.");
  }

  const violations = events
    .filter((item) => item.type === TrajectoryEventType.ToolCall)
    .filter((item) => matchesOptionalRule(item, rule.match))
    .filter((item) => !allowed.some((pattern) => patternMatches(item.tool, pattern)))
    .map((item) => {
      const tool = item.tool ?? "<missing>";
      return eventViolation(rule, item, `Tool ${tool} is not allowed by rule ${rule.id}.`);
    });

  return result(rule, violations);
}

function evaluateFieldConstraint(events: readonly TrajectoryEvent[], rule: RuleSpec): RuleResult {
  if (rule.field === undefined) {
    return configError(rule, "field_constraint rule requires a field.");
  }

  const violations: RuleViolation[] = [];
  for (const item of events) {
    if (!matchesOptionalRule(item, rule.match)) continue;

    const value = fieldValue(item, rule.field);
    if (rule.exists === true && value === undefined) {
      violations.push(
        eventViolation(rule, item, `Field ${rule.field} must exist for rule ${rule.id}.`),
      );
    }
    if (rule.exists === false && value !== undefined) {
      violations.push(
        eventViolation(rule, item, `Field ${rule.field} must not exist for rule ${rule.id}.`),
      );
    }
    if (rule.not_exists === true && value !== undefined) {
      violations.push(
        eventViolation(rule, item, `Field ${rule.field} must not exist for rule ${rule.id}.`),
      );
    }
    if (hasOwn(rule, "equals") && !valuesEqual(value, rule.equals)) {
      violations.push(
        eventViolation(
          rule,
          item,
          `Field ${rule.field} must equal expected value for rule ${rule.id}.`,
        ),
      );
    }
    if (hasOwn(rule, "not_equals") && valuesEqual(value, rule.not_equals)) {
      violations.push(
        eventViolation(
          rule,
          item,
          `Field ${rule.field} must not equal forbidden value for rule ${rule.id}.`,
        ),
      );
    }
    if (rule.match_value !== undefined && !patternMatches(value, rule.match_value)) {
      violations.push(
        eventViolation(
          rule,
          item,
          `Field ${rule.field} must match ${rule.match_value} for rule ${rule.id}.`,
        ),
      );
    }
    if (rule.not_match !== undefined && patternMatches(value, rule.not_match)) {
      violations.push(
        eventViolation(
          rule,
          item,
          `Field ${rule.field} must not match ${rule.not_match} for rule ${rule.id}.`,
        ),
      );
    }
  }

  return result(rule, violations);
}

function evaluatePrecedes(events: readonly TrajectoryEvent[], rule: RuleSpec): RuleResult {
  if (rule.trigger === undefined) {
    return configError(rule, "precedes rule requires a trigger matcher.");
  }
  if (rule.required === undefined) {
    return configError(rule, "precedes rule requires a required matcher.");
  }

  const trigger = rule.trigger;
  const required = rule.required;
  const violations: RuleViolation[] = [];
  for (const item of events) {
    if (!matchesEvent(item, trigger)) continue;

    const hasPrior = events.some((candidate) => {
      return candidate.seq < item.seq && requiredMatchesTrigger(candidate, item, required);
    });

    if (!hasPrior) {
      violations.push(
        eventViolation(
          rule,
          item,
          `Rule ${rule.id} requires prior matching evidence before ${formatSeq(item.seq)}.`,
        ),
      );
    }
  }

  return result(rule, violations);
}

function requiredMatchesTrigger(
  candidate: TrajectoryEvent,
  trigger: TrajectoryEvent,
  required: RequiredMatcher,
): boolean {
  if (!matchesEvent(candidate, required)) return false;
  if (required.match_field === undefined) return true;

  const candidateValue = fieldValue(candidate, required.match_field);
  const triggerValue = fieldValue(trigger, required.match_field);
  return (
    candidateValue !== undefined &&
    triggerValue !== undefined &&
    valuesEqual(candidateValue, triggerValue)
  );
}

function matchesOptionalRule(event: TrajectoryEvent, matcher: EventMatcher | undefined): boolean {
  return matcher === undefined || matchesEvent(event, matcher);
}

function result(rule: RuleSpec, violations: readonly RuleViolation[]): RuleResult {
  return violations.length === 0 ? pass(rule) : fail(rule, violations);
}

function pass(rule: RuleSpec): RuleResult {
  return {
    ruleId: rule.id,
    status: "pass",
    violations: [],
  };
}

function fail(rule: RuleSpec, violations: readonly RuleViolation[]): RuleResult {
  return {
    ruleId: rule.id,
    status: "fail",
    violations,
  };
}

function configError(rule: RuleSpec, message: string): RuleResult {
  return fail(rule, [
    {
      ruleId: rule.id,
      message,
    },
  ]);
}

function eventViolation(rule: RuleSpec, event: TrajectoryEvent, message: string): RuleViolation {
  return {
    ruleId: rule.id,
    message,
    seq: event.seq,
    seqRef: formatSeq(event.seq),
    source: event.source,
    eventType: event.type,
    tool: event.tool,
    status: event.status,
    spanId: event.spanId,
    messageSnippet: snippet(event.message ?? event.error),
  };
}

function snippet(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

function hasOwn<Key extends keyof RuleSpec>(rule: RuleSpec, key: Key): boolean {
  return Object.hasOwn(rule, key);
}
