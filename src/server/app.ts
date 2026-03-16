/**
 * Grove HTTP server application factory.
 *
 * createApp(deps) returns a Hono application with all routes mounted.
 * Dependencies are injected via context variables, enabling easy testing.
 *
 * ## Security / Auth Model
 *
 * The HTTP server is designed for **local and trusted-network use only**.
 *
 * - No authentication or authorization middleware is enforced.
 * - Agent IDs are self-reported by callers and are **not verified** by the
 *   server — any client can claim any agent identity.
 * - For internet-facing or production deployments, place the server behind a
 *   reverse proxy (e.g. nginx, Caddy, or a cloud load-balancer) that provides
 *   TLS termination and authentication.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ServerDeps, ServerEnv } from "./deps.js";
import { handleError } from "./middleware/error-handler.js";
import { agents } from "./routes/agents.js";
import { boardroom } from "./routes/boardroom.js";
import { bounties } from "./routes/bounties.js";
import { claims } from "./routes/claims.js";
import { contributions } from "./routes/contributions.js";
import { dag } from "./routes/dag.js";
import { diff } from "./routes/diff.js";
import { frontier } from "./routes/frontier.js";
import { gossip } from "./routes/gossip.js";
import { grove } from "./routes/grove.js";
import { outcomes } from "./routes/outcomes.js";
import { search } from "./routes/search.js";
import { threads } from "./routes/threads.js";

/**
 * Create a Hono application with all grove-server routes.
 *
 * @param deps - Injected dependencies (stores, CAS, frontier calculator).
 * @returns Configured Hono application.
 */
export function createApp(deps: ServerDeps): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // Global body-size limit (10 MB)
  app.use("*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

  // Inject dependencies into every request's context
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

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

  // Centralized error handling
  app.onError(handleError);

  return app;
}
