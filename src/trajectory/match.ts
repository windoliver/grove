import { isDeepStrictEqual } from "node:util";
import type { EventMatcher, TrajectoryEvent, TrajectoryEventType } from "./types.js";
import { isTrajectoryEventType } from "./types.js";

export function normalizeEventTypeName(value: string): TrajectoryEventType | undefined {
  const upper = value.trim().toUpperCase();
  return isTrajectoryEventType(upper) ? upper : undefined;
}

function matchesEventType(value: TrajectoryEventType, pattern: string): boolean {
  const normalized = pattern.split("|").map((part) => normalizeEventTypeName(part));
  return normalized.every((part) => part !== undefined) && normalized.includes(value);
}

export function fieldValue(source: unknown, path: string): unknown {
  if (path.length === 0) return undefined;
  const parts = path.split(".");
  let current = source;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function patternMatches(value: unknown, pattern: string): boolean {
  if (value === undefined || value === null) return false;
  const text = String(value);
  return pattern.split("|").some((part) => globPartMatches(text, part));
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function matchesEvent(event: TrajectoryEvent, matcher: EventMatcher): boolean {
  if (matcher.event !== undefined && !matchesEventType(event.type, matcher.event)) {
    return false;
  }

  if (matcher.tool !== undefined && !patternMatches(event.tool, matcher.tool)) {
    return false;
  }

  for (const [path, pattern] of Object.entries(matcher.field_match ?? {})) {
    if (!patternMatches(fieldValue(event, path), pattern)) return false;
  }

  for (const [path, pattern] of Object.entries(matcher.field_not_match ?? {})) {
    if (patternMatches(fieldValue(event, path), pattern)) return false;
  }

  return true;
}

function globPartMatches(value: string, pattern: string): boolean {
  const wildcardStar = "\u0000";
  const wildcardQuestion = "\u0001";
  const escaped = pattern
    .replaceAll("*", wildcardStar)
    .replaceAll("?", wildcardQuestion)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll(wildcardStar, ".*")
    .replaceAll(wildcardQuestion, ".");
  return new RegExp(`^${escaped}$`).test(value);
}
