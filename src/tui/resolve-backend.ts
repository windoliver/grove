/**
 * Backend resolution for `grove tui`.
 *
 * Determines which data provider to use based on CLI flags,
 * environment variables, and grove.json configuration.
 * Priority chain: --url > --nexus > GROVE_NEXUS_URL > grove.json nexusUrl > Docker discovery > local.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGroveDir } from "../cli/utils/grove-dir.js";
import type { GroveContract } from "../core/contract.js";
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
      readonly source: "flag" | "env" | "grove.json" | "docker";
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
// resolveBackend — now async to support Docker discovery
// ---------------------------------------------------------------------------

/**
 * Resolve which backend the TUI should connect to.
 *
 * Priority chain:
 * 1. `--url` flag -> remote mode
 * 2. `--nexus` flag -> nexus mode (source: "flag")
 * 3. `GROVE_NEXUS_URL` env -> nexus mode (source: "env")
 * 4. `grove.json` nexusUrl -> nexus mode (source: "grove.json")
 * 5. Docker container discovery -> nexus mode (source: "docker")
 * 6. Fallback -> local mode
 */
export async function resolveBackend(flags: ResolveBackendFlags): Promise<ResolvedBackend> {
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

  // 4. grove.json nexusUrl or nexus.yaml port — trust config without health check.
  // The URL comes from user configuration (nexusUrl) or managed Nexus (nexus.yaml).
  // Both are authoritative. Health checking happens downstream at connect time.
  const { url: configUrl } = readNexusUrlFromConfig(flags.groveOverride);
  if (configUrl) {
    return {
      mode: "nexus",
      url: configUrl,
      source: "grove.json",
      groveOverride: flags.groveOverride,
    };
  }

  // 5. Docker container discovery — when grove.json says nexusManaged but no URL
  // was found (no nexus.yaml, no explicit nexusUrl). Try Docker port mapping.
  if (isNexusManagedConfig(flags.groveOverride)) {
    try {
      const { discoverRunningNexus, readNexusApiKey } =
        require("../cli/nexus-lifecycle.js") as typeof import("../cli/nexus-lifecycle.js");
      const discovered = await discoverRunningNexus();
      if (discovered) {
        // Set the API key env so downstream code (health checks, providers) can use it
        const { groveDir } = resolveGroveDir(flags.groveOverride);
        const apiKey = readNexusApiKey(join(groveDir, ".."));
        if (apiKey && !process.env.NEXUS_API_KEY) {
          process.env.NEXUS_API_KEY = apiKey;
        }
        return {
          mode: "nexus",
          url: discovered,
          source: "docker",
          groveOverride: flags.groveOverride,
        };
      }
    } catch {
      // Docker not available or no container running — fall through
    }
  }

  // 6. Local fallback
  return {
    mode: "local",
    groveOverride: flags.groveOverride,
    source: flags.groveOverride ? "flag" : "default",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if grove.json explicitly indicates a managed Nexus deployment. */
function isNexusManagedConfig(groveOverride?: string): boolean {
  try {
    const { groveDir } = resolveGroveDir(groveOverride);
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) return false;
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as { nexusManaged?: boolean };
    // Only true when explicitly managed — not just mode: "nexus"
    return parsed.nexusManaged === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config file reader
// ---------------------------------------------------------------------------

/** Read nexusUrl from .grove/grove.json if it exists. Returns the URL and whether it was explicit. */
function readNexusUrlFromConfig(
  groveOverride?: string,
): { url: string; fromExplicit: boolean } | { url: undefined; fromExplicit: false } {
  const none = { url: undefined, fromExplicit: false } as const;
  try {
    const { groveDir } = resolveGroveDir(groveOverride);
    const configPath = join(groveDir, "grove.json");
    if (!existsSync(configPath)) return none;

    const raw = readFileSync(configPath, "utf-8");

    // Try typed parsing first; fall back to raw JSON for backward compat
    try {
      const { parseGroveConfig } =
        require("../core/config.js") as typeof import("../core/config.js");
      const config = parseGroveConfig(raw);
      if (config.nexusUrl) return { url: config.nexusUrl, fromExplicit: true };

      // Managed Nexus: no nexusUrl in grove.json — discover from nexus.yaml.
      // This handles standalone `grove tui` on a managed-Nexus grove where
      // `grove up` already started Nexus but didn't set GROVE_NEXUS_URL.
      if (config.nexusManaged && config.mode === "nexus") {
        const { readNexusUrl } =
          require("../cli/nexus-lifecycle.js") as typeof import("../cli/nexus-lifecycle.js");
        const yamlUrl = readNexusUrl(join(groveDir, ".."));
        if (yamlUrl) return { url: yamlUrl, fromExplicit: false };
      }

      return none;
    } catch {
      // Fall back to untyped parse (e.g., when zod isn't available in test/CI)
      const parsed = JSON.parse(raw) as {
        nexusUrl?: string;
        nexusManaged?: boolean;
        mode?: string;
      };
      if (parsed.nexusUrl) return { url: parsed.nexusUrl, fromExplicit: true };

      // Managed Nexus fallback: discover from nexus.yaml
      if (parsed.nexusManaged && parsed.mode === "nexus") {
        try {
          const { readNexusUrl } =
            require("../cli/nexus-lifecycle.js") as typeof import("../cli/nexus-lifecycle.js");
          const yamlUrl = readNexusUrl(join(groveDir, ".."));
          if (yamlUrl) return { url: yamlUrl, fromExplicit: false };
        } catch {
          // nexus-lifecycle not available
        }
      }
      return none;
    }
  } catch {
    return none;
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

/**
 * Load the full parsed GroveContract from a resolved backend.
 * Returns undefined if no GROVE.md is found or parsing fails.
 */
export async function loadContract(backend: ResolvedBackend): Promise<GroveContract | undefined> {
  if (backend.mode === "remote") {
    // Fetch contract from remote grove-server
    try {
      const resp = await fetch(`${backend.url.replace(/\/+$/, "")}/api/grove/contract`);
      if (resp.ok) {
        return (await resp.json()) as GroveContract;
      }
    } catch {
      // Contract not available from remote
    }
    return undefined;
  }

  // Local + nexus: read from local GROVE.md contract.
  try {
    const { parseGroveContract } = await import("../core/contract.js");
    const { groveDir } = resolveGroveDir(backend.groveOverride);
    const grovemdPath = join(groveDir, "..", "GROVE.md");
    if (existsSync(grovemdPath)) {
      const raw = await Bun.file(grovemdPath).text();
      return parseGroveContract(raw);
    }
  } catch {
    // Contract is optional
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
          : backend.source === "docker"
            ? `nexus (auto: docker)`
            : `nexus (auto: grove.json)`;
    case "local":
      return "local (.grove/)";
  }
}
