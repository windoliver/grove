/**
 * Grove HTTP server application factory.
 *
 * createApp(deps, registry) returns a Hono application with all routes mounted.
 * Dependencies are injected via context variables, enabling easy testing.
 *
 * ## Security / Auth Model
 *
 * All /api/* routes require a valid bearer token from `.grove/server-keys.yaml`.
 * The token resolves to a namespace that is injected into each request context.
 * Requests without a valid token receive 400 (missing) or 401 (unrecognized).
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerDeps, ServerEnv } from "./deps.js";
import { handleError } from "./middleware/error-handler.js";
import { type KeyRegistry, namespaceAuth } from "./middleware/namespace-auth.js";
import { agentTasks } from "./routes/agent-tasks.js";
import { agents } from "./routes/agents.js";
import { boardroom } from "./routes/boardroom.js";
import { bounties } from "./routes/bounties.js";
import { claims } from "./routes/claims.js";
import { contributions } from "./routes/contributions.js";
import { dag } from "./routes/dag.js";
import { diff } from "./routes/diff.js";
import { frontier } from "./routes/frontier.js";
import { goals } from "./routes/goals.js";
import { gossip } from "./routes/gossip.js";
import { grove } from "./routes/grove.js";
import { handoffs } from "./routes/handoffs.js";
import { health } from "./routes/health.js";
import { outcomes } from "./routes/outcomes.js";
import { search } from "./routes/search.js";
import { sessions } from "./routes/sessions.js";
import { threads } from "./routes/threads.js";
import { watch } from "./routes/watch.js";

/**
 * Create a Hono application with all grove-server routes.
 *
 * @param deps - Injected dependencies (stores, CAS, frontier calculator).
 * @param registry - Bearer-token → namespace registry loaded from server-keys.yaml.
 * @returns Configured Hono application.
 */
export function createApp(deps: ServerDeps, registry: KeyRegistry): Hono<ServerEnv> {
  // Data isolation requires that all keys in the registry map to the same namespace.
  // Routes use process-global stores (scoped to the server's single namespace); a
  // registry with multiple namespaces would allow cross-namespace data access.
  // serve.ts enforces this by filtering the loaded registry to the server's own zoneId.
  const uniqueNamespaces = new Set(registry.values());
  if (uniqueNamespaces.size > 1) {
    throw new Error(
      `createApp: registry contains ${uniqueNamespaces.size} distinct namespaces — ` +
        `routes use shared process-global stores so cross-namespace access would be possible. ` +
        `Each server process must serve exactly one namespace. ` +
        `Filter the registry to the server's own namespace before calling createApp.`,
    );
  }

  const app = new Hono<ServerEnv>();

  // Global body-size limit (10 MB)
  app.use("*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

  // Inject dependencies into every request's context
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  // Health check — exempt from namespace auth (used by grove up readiness probes)
  app.route("/health", health);

  // Gossip federation requires HMAC when the service is enabled — POST gossip routes are
  // exempt from bearer auth (peers use HMAC instead), so allowing gossip without a secret
  // would leave exchange/shuffle completely unauthenticated.
  if (deps.gossip && !deps.gossipHmacSecret) {
    throw new Error(
      "createApp: deps.gossip is configured but deps.gossipHmacSecret is absent. " +
        "Set GROVE_GOSSIP_HMAC_SECRET to authenticate gossip peers, or disable gossip.",
    );
  }

  // All /api/* routes require a valid namespace bearer token.
  // POST gossip endpoints are exempt — they verify HMAC signatures from peer servers.
  // GET gossip endpoints (peers, frontier) still require a bearer token.
  app.use(
    "/api/*",
    namespaceAuth(registry, {
      exempt: (c) =>
        deps.gossip !== undefined &&
        c.req.method === "POST" &&
        c.req.path.startsWith("/api/gossip"),
    }),
  );

  // E2E access log — logs authenticated /api/* requests when GROVE_ACCESS_LOG=1
  if (process.env.GROVE_ACCESS_LOG) {
    app.use("/api/*", async (c, next) => {
      const ns = c.get("namespace") as string | undefined;
      process.stdout.write(`[access] ${c.req.method} ${c.req.path} ns=${ns ?? "NONE"}\n`);
      await next();
    });
  }

  // Mount route groups
  app.route("/api/agents", agents);
  app.route("/api/agent-tasks", agentTasks);
  app.route("/api/boardroom", boardroom);
  app.route("/api/contributions", contributions);
  app.route("/api/frontier", frontier);
  app.route("/api/search", search);
  app.route("/api/dag", dag);
  app.route("/api/diff", diff);
  app.route("/api/threads", threads);
  app.route("/api/claims", claims);
  app.route("/api/bounties", bounties);
  app.route("/api/gossip", gossip);
  app.route("/api/grove", grove);
  app.route("/api/outcomes", outcomes);
  app.route("/api/session", goals);
  app.route("/api/sessions", sessions);
  app.route("/api/handoffs", handoffs);
  app.route("/api", watch);

  // Centralized error handling
  app.onError(handleError);

  return app;
}
