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

/**
 * Create a Hono application with all grove-server routes.
 *
 * @param deps - Injected dependencies (stores, CAS, frontier calculator).
 * @param registry - Bearer-token → namespace registry loaded from server-keys.yaml.
 * @returns Configured Hono application.
 */
export function createApp(deps: ServerDeps, registry: KeyRegistry): Hono<ServerEnv> {
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

  // All /api/* routes require a valid namespace bearer token
  app.use("/api/*", namespaceAuth(registry));

  // Mount route groups
  app.route("/api/agents", agents);
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

  // Centralized error handling
  app.onError(handleError);

  return app;
}
