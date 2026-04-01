/**
 * Shared Zod schema for session creation input.
 *
 * Single source of truth used by: CLI, API route, TUI, and core SessionManager.
 * All input types are derived from this schema via z.infer<>.
 */

import { z } from "zod";

/**
 * Schema for creating a new session.
 *
 * The `config` field accepts a full GroveContract snapshot as a loose
 * JSON record. Full contract validation happens at parse time via
 * parseGroveContract(); this schema only ensures the shape is an object.
 */
export const SessionCreateSchema: z.ZodObject<{
  goal: z.ZodOptional<z.ZodString>;
  presetName: z.ZodOptional<z.ZodString>;
  config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}> = z.object({
  goal: z.string().min(1).optional(),
  presetName: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export type SessionCreateInput = z.infer<typeof SessionCreateSchema>;
