/**
 * Zod schema for .grove/grove.json configuration.
 *
 * Provides typed parsing, validation, and serialization for the
 * grove configuration file that lives alongside the SQLite database.
 */

import { writeFileSync } from "node:fs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TypeScript type (explicit for isolatedDeclarations)
// ---------------------------------------------------------------------------

/** Service configuration for grove server and MCP transport. */
export interface GroveServices {
  readonly server: boolean;
  readonly mcp: boolean;
}

/** Backend mode: local SQLite, nexus cluster, or remote HTTP. */
export type GroveMode = "local" | "nexus" | "remote";

/** Typed grove.json configuration. */
export interface GroveConfig {
  readonly name: string;
  readonly mode: GroveMode;
  readonly preset?: string | undefined;
  readonly nexusUrl?: string | undefined;
  readonly remoteUrl?: string | undefined;
  readonly services?: GroveServices | undefined;
  readonly backend?: string | undefined;
  /**
   * When true, `grove up` manages the Nexus lifecycle (init/up/down).
   * When false or absent with mode "nexus", Nexus is externally managed
   * and nexusUrl must point to a running instance.
   */
  readonly nexusManaged?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

/** Service configuration for grove server and MCP transport. */
const ServicesSchema = z
  .object({
    server: z.boolean().default(false),
    mcp: z.boolean().default(false),
  })
  .strict()
  .optional();

/** Backend mode: local SQLite, nexus cluster, or remote HTTP. */
const ModeSchema = z.enum(["local", "nexus", "remote"]).default("local");

/** Full grove.json configuration schema. */
export const GroveConfigSchema: z.ZodType<GroveConfig> = z
  .object({
    name: z.string().min(1).max(128),
    mode: ModeSchema,
    preset: z.string().min(1).max(64).optional(),
    nexusUrl: z.string().url().optional(),
    remoteUrl: z.string().url().optional(),
    services: ServicesSchema,
    backend: z.string().min(1).max(64).optional(),
    nexusManaged: z.boolean().optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    // nexusUrl is required when mode is "nexus" UNLESS grove manages the
    // Nexus lifecycle (nexusManaged: true), in which case it defaults to
    // http://localhost:2026 at runtime.
    if (config.mode === "nexus" && !config.nexusUrl && !config.nexusManaged) {
      ctx.addIssue({
        code: "custom",
        message:
          "nexusUrl is required when mode is 'nexus' (or set nexusManaged: true for grove-managed Nexus)",
      });
    }
    if (config.mode === "remote" && !config.remoteUrl) {
      ctx.addIssue({
        code: "custom",
        message: "remoteUrl is required when mode is 'remote'",
      });
    }
  }) as z.ZodType<GroveConfig>;

// ---------------------------------------------------------------------------
// Parse & write
// ---------------------------------------------------------------------------

/**
 * Parse and validate raw JSON string as a GroveConfig.
 * Throws a descriptive error on invalid input.
 */
export function parseGroveConfig(raw: string): GroveConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("grove.json is not valid JSON");
  }

  const result = GroveConfigSchema.safeParse(parsed);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid grove.json:\n${messages.join("\n")}`);
  }
  return result.data;
}

/**
 * Serialize a GroveConfig to JSON and write it to disk.
 */
export function writeGroveConfig(config: GroveConfig, path: string): void {
  // Validate before writing to prevent corrupt configs
  GroveConfigSchema.parse(config);

  // Build a clean object without undefined values
  const obj: Record<string, unknown> = {
    name: config.name,
    mode: config.mode,
  };
  if (config.preset !== undefined) obj.preset = config.preset;
  if (config.nexusUrl !== undefined) obj.nexusUrl = config.nexusUrl;
  if (config.remoteUrl !== undefined) obj.remoteUrl = config.remoteUrl;
  if (config.services !== undefined) obj.services = config.services;
  if (config.backend !== undefined) obj.backend = config.backend;
  if (config.nexusManaged !== undefined) obj.nexusManaged = config.nexusManaged;

  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`, "utf-8");
}
