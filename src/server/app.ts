/**
 * Grove HTTP server application factory.
 *
 * createApp(deps) returns a Hono application with all routes mounted.
 * Dependencies are injected via context variables, enabling easy testing.
 */

import { Hono } from "hono";
import type { ServerDeps, ServerEnv } from "./deps.js";
import { handleError } from "./middleware/error-handler.js";
import { claims } from "./routes/claims.js";
import { contributions } from "./routes/contributions.js";
import { dag } from "./routes/dag.js";
import { frontier } from "./routes/frontier.js";
import { gossip } from "./routes/gossip.js";
import { grove } from "./routes/grove.js";
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

  // Inject dependencies into every request's context
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  // Mount route groups
  app.route("/api/contributions", contributions);
  app.route("/api/frontier", frontier);
  app.route("/api/search", search);
  app.route("/api/dag", dag);
  app.route("/api/threads", threads);
  app.route("/api/claims", claims);
  app.route("/api/gossip", gossip);
  app.route("/api/grove", grove);

  // Centralized error handling
  app.onError(handleError);

  return app;
}
