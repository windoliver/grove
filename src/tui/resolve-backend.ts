/**
 * Backend resolution for `grove tui`.
 *
 * Determines which data provider to use based on CLI flags,
 * environment variables, and grove.json configuration.
 * Priority chain: --url > --nexus > GROVE_NEXUS_URL > grove.json nexusUrl > local.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGroveDir } from "../cli/utils/grove-dir.js";
import type { AgentTopology } from "../core/topology.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated union describing the resolved backend. */
export type ResolvedBackend =
  | { readonly mode: "remote"; readonly url: string; readonly source: "flag" }
  | {
      readonly mode: "nexus";
      readonly url: string;
      readonly source: "flag" | "env" | "grove.json";
      readonly groveOverride?: string | undefined;
    }
  | {
      readonly mode: "local";
      readonly groveOverride?: string | undefined;
      readonly source: "default" | "flag";
    };

/** Input flags for backend resolution. */
export interface ResolveBackendFlags {
  readonly url?: string | undefined;
  readonly nexus?: string | undefined;
  readonly groveOverride?: string | undefined;
}

// ---------------------------------------------------------------------------
// resolveBackend — pure function
// ---------------------------------------------------------------------------

/**
 * Resolve which backend the TUI should connect to.
 *
 * Priority chain:
 * 1. `--url` flag -> remote mode
 * 2. `--nexus` flag -> nexus mode (source: "flag")
 * 3. `GROVE_NEXUS_URL` env -> nexus mode (source: "env")
 * 4. `grove.json` nexusUrl -> nexus mode (source: "grove.json")
 * 5. Fallback -> local mode
 *
 * Steps 3-4 are short-circuited if an explicit flag (step 1 or 2) matched.
 */
export function resolveBackend(flags: ResolveBackendFlags): ResolvedBackend {
  // 1. Explicit --url flag -> remote
  if (flags.url) {
    return { mode: "remote", url: flags.url, source: "flag" };
  }

  // 2. Explicit --nexus flag -> nexus
  if (flags.nexus) {
    return { mode: "nexus", url: flags.nexus, source: "flag", groveOverride: flags.groveOverride };
  }

  // 3. GROVE_NEXUS_URL env
  const envUrl = process.env.GROVE_NEXUS_URL;
  if (envUrl) {
    return { mode: "nexus", url: envUrl, source: "env", groveOverride: flags.groveOverride };
  }

  // 4. grove.json nexusUrl
  const nexusFromConfig = readNexusUrlFromConfig(flags.groveOverride);
  if (nexusFromConfig) {
    return {
      mode: "nexus",
      url: nexusFromConfig,
      source: "grove.json",
      groveOverride: flags.groveOverride,
    };
  }

  // 5. Local fallback
  return {
    mode: "local",
    groveOverride: flags.groveOverride,
    source: flags.groveOverride ? "flag" : "default",
  };
}

// ---------------------------------------------------------------------------
// Config file reader
// ---------------------------------------------------------------------------

/** Read nexusUrl from .grove/grove.json if it exists. Returns undefined on any failure. */
function readNexusUrlFromConfig(groveOverride?: string): string | undefined {
  try {
    const { groveDir } = resolveGroveDir(groveOverride);
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) return undefined;

    const raw = readFileSync(configPath, "utf-8");

    // Try typed parsing first; fall back to raw JSON for backward compat
    try {
      const { parseGroveConfig } =
        require("../core/config.js") as typeof import("../core/config.js");
      const config = parseGroveConfig(raw);
      if (config.nexusUrl) return config.nexusUrl;

      // Managed Nexus: no nexusUrl in grove.json — discover from nexus.yaml.
      // This handles standalone `grove tui` on a managed-Nexus grove where
      // `grove up` already started Nexus but didn't set GROVE_NEXUS_URL.
      if (config.nexusManaged && config.mode === "nexus") {
        const { readNexusUrl } =
          require("../cli/nexus-lifecycle.js") as typeof import("../cli/nexus-lifecycle.js");
        return readNexusUrl(join(groveDir, ".."));
      }

      return undefined;
    } catch {
      // Fall back to untyped parse for legacy grove.json files
      const parsed = JSON.parse(raw) as { nexusUrl?: string };
      return parsed.nexusUrl || undefined;
    }
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// checkNexusHealth
// ---------------------------------------------------------------------------

/** Default timeout for health checks (milliseconds). */
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;

/**
 * Health check result.
 *
 * - `ok`: 2xx — Nexus is working.
 * - `auth_required`: 401/403 — server is Nexus but needs credentials
 *   (no credential path currently exists in the TUI startup).
 * - `not_nexus`: 404/405 — endpoint doesn't exist, wrong server.
 * - `server_error`: 5xx — server error.
 * - `unreachable`: network failure, timeout, DNS.
 */
export type NexusHealthStatus =
  | "ok"
  | "auth_required"
  | "not_nexus"
  | "server_error"
  | "unreachable";

/**
 * Lightweight health check against a Nexus server.
 *
 * Sends a minimal JSON-RPC `exists` call to `POST /api/nfs/exists`,
 * which matches the Nexus wire protocol (all VFS ops go through
 * `POST /api/nfs/{method}` as JSON-RPC).
 */
export async function checkNexusHealth(
  url: string,
  timeoutMs?: number,
): Promise<NexusHealthStatus> {
  try {
    const apiKey = process.env.NEXUS_API_KEY;
    const resp = await fetch(`${url.replace(/\/+$/, "")}/api/nfs/exists`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "exists", params: { path: "/" }, id: 1 }),
      signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS),
    });
    if (resp.ok) return "ok";
    if (resp.status === 401 || resp.status === 403) return "auth_required";
    if (resp.status === 404 || resp.status === 405) return "not_nexus";
    return "server_error";
  } catch {
    return "unreachable";
  }
}

// ---------------------------------------------------------------------------
// loadTopology
// ---------------------------------------------------------------------------

/**
 * Load agent topology for the resolved backend.
 *
 * - remote: fetches from `${url}/api/grove/topology`
 * - nexus: tries remote endpoint first, falls back to local GROVE.md
 * - local: reads GROVE.md contract from the parent of .grove/
 */
export async function loadTopology(backend: ResolvedBackend): Promise<AgentTopology | undefined> {
  if (backend.mode === "remote") {
    try {
      const resp = await fetch(`${backend.url.replace(/\/+$/, "")}/api/grove/topology`);
      if (resp.ok) {
        return (await resp.json()) as AgentTopology;
      }
    } catch {
      // Topology not available
    }
    return undefined;
  }

  // Local + nexus: read from local GROVE.md contract.
  // For nexus mode the grove.json is local, so GROVE.md should be adjacent.
  try {
    const { parseGroveContract } = await import("../core/contract.js");
    const { groveDir } = resolveGroveDir(backend.groveOverride);
    const grovemdPath = join(groveDir, "..", "GROVE.md");
    if (existsSync(grovemdPath)) {
      const raw = await Bun.file(grovemdPath).text();
      const contract = parseGroveContract(raw);
      return contract.topology;
    }
  } catch {
    // Topology is optional
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// backendLabel helper
// ---------------------------------------------------------------------------

/** Generate a human-readable label for the active backend. */
export function backendLabel(backend: ResolvedBackend): string {
  switch (backend.mode) {
    case "remote":
      return `remote (${backend.url})`;
    case "nexus":
      return backend.source === "flag"
        ? `nexus (--nexus)`
        : backend.source === "env"
          ? `nexus (auto: env)`
          : `nexus (auto: grove.json)`;
    case "local":
      return "local (.grove/)";
  }
}
