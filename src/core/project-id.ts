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

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidProjectId(s: string): boolean {
  return UUID_V4_REGEX.test(s);
}

export function generateProjectId(): string {
  return randomUUID();
}

export function readProjectId(groveDir: string): string | null {
  const path = join(groveDir, PROJECT_ID_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const trimmed = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (trimmed === "") return null;
  if (!isValidProjectId(trimmed)) {
    throw new Error(`Invalid project id in ${path}. Fix the file or delete it to regenerate.`);
  }
  return trimmed;
}

export function writeProjectId(groveDir: string, id: string): void {
  if (!isValidProjectId(id)) {
    throw new Error(`Cannot write invalid project id: ${JSON.stringify(id)}`);
  }
  const target = join(groveDir, PROJECT_ID_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${id}\n`, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, target);
}
