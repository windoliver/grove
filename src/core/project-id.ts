/**
 * Project identity — persistent UUIDv4 for a Grove-initialized clone.
 *
 * The project id lives at `<groveDir>/project-id` as a single UUIDv4 line.
 * It is created by `grove init` and is immutable for the life of the clone.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_ID_FILE = "project-id";

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidProjectId(s: string): boolean {
  return UUID_V4_REGEX.test(s);
}

export function generateProjectId(): string {
  return randomUUID();
}
