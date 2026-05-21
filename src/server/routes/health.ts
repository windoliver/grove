/**
 * Health check endpoint.
 *
 * GET /health — Returns server health status.
 */

import type { Hono as HonoType } from "hono";
import { Hono } from "hono";
import type { ServerEnv } from "../deps.js";

const health: HonoType<ServerEnv> = new Hono<ServerEnv>();

/** GET /health — Health check. */
health.get("/", async (c) => {
  const { contributionStore, claimStore, cas } = c.get("deps");

  // Verify core stores are reachable by performing lightweight reads
  const checks: Record<string, "ok" | "error"> = {};
  try {
    await contributionStore.count();
    checks.contributionStore = "ok";
  } catch {
    checks.contributionStore = "error";
  }
  try {
    await claimStore.countActiveClaims();
    checks.claimStore = "ok";
  } catch {
    checks.claimStore = "error";
  }
  try {
    // CAS: attempt a get on a nonexistent key — should return null, not throw
    await cas.get(`blake3:${"0".repeat(64)}`);
    checks.cas = "ok";
  } catch {
    checks.cas = "error";
  }

  const healthy = Object.values(checks).every((v) => v === "ok");

  // Grove-Server-Pid: diagnostic only.
  // Grove-Health-Token: authoritative readiness proof — echoes the
  // GROVE_HEALTH_TOKEN env value the parent injected at spawn time. The
  // spawner in service-lifecycle.waitForOwnedReadiness checks this against
  // the per-spawn unguessable token so a foreign listener cannot spoof
  // readiness on the unauthenticated /health endpoint.
  c.header("Grove-Server-Pid", String(process.pid));
  const token = process.env.GROVE_HEALTH_TOKEN;
  if (token) c.header("Grove-Health-Token", token);

  return c.json(
    {
      status: healthy ? "ok" : "degraded",
      checks,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    healthy ? 200 : 503,
  );
});

export { health };
