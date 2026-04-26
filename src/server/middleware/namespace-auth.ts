import { readFileSync } from "node:fs";
import type { MiddlewareHandler } from "hono";
import { parse as parseYaml } from "yaml";
import { NamespaceMissingError, NamespaceUnauthorizedError } from "../../core/errors.js";
import type { ServerEnv } from "../deps.js";

export type KeyRegistry = Map<string, string>; // key → namespace

interface ServerKeysFile {
  version: 1;
  keys: Record<string, { namespace: string; createdAt: string }>;
}

/**
 * Load `.grove/server-keys.yaml` into an in-memory Map<key, namespace>.
 * Returns an empty Map if the file is absent (all API calls will return 400
 * until `grove init` has been run).
 */
export function loadKeyRegistry(serverKeysPath: string): KeyRegistry {
  let raw: string;
  try {
    raw = readFileSync(serverKeysPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const parsed = parseYaml(raw) as ServerKeysFile | null;
  if (!parsed?.keys) return new Map();
  const registry: KeyRegistry = new Map();
  for (const [key, entry] of Object.entries(parsed.keys)) {
    if (entry?.namespace) registry.set(key, entry.namespace);
  }
  return registry;
}

/**
 * Hono middleware that enforces namespace-scoped bearer-token auth on /api/*.
 *
 * On success: sets `c.get("namespace")` to the resolved namespace string.
 * On failure: throws NamespaceMissingError (→ 400) or NamespaceUnauthorizedError (→ 401).
 */
export function namespaceAuth(registry: KeyRegistry): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) {
      throw new NamespaceMissingError();
    }
    const key = auth.slice(7).trim();
    const ns = registry.get(key);
    if (!ns) {
      throw new NamespaceUnauthorizedError();
    }
    c.set("namespace", ns);
    await next();
  };
}
