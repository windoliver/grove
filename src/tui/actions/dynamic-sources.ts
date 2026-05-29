import { checkSpawn } from "../agents/spawn-validator.js";
import type { Action, ActionContext, DynamicSource } from "./types.js";

export const sessionNavSource: DynamicSource = (ctx) =>
  ctx.sessions.map((session) => ({
    id: `nav.session.${session}`,
    label: `Jump to session ${session}`,
    detail: "session",
    group: "Navigation",
    keywords: ["session", "agent", "jump"],
    run: (c) => c.jumpToSession(session),
  }));

export const spawnSource: DynamicSource = (ctx) => {
  const actions: Action[] = [];
  if (!ctx.canSpawn) return actions;
  // Spawn from profiles first, then topology roles not covered by a profile.
  const profileRoles = new Set<string>();
  for (const profile of ctx.profiles) {
    // De-dupe by role: two profiles sharing a role would otherwise emit a
    // duplicate `agent.spawn.<role>` id. First profile for a role wins.
    if (profileRoles.has(profile.role)) continue;
    profileRoles.add(profile.role);
    const role = profile.role;
    actions.push({
      id: `agent.spawn.${role}`,
      label: `Spawn ${profile.name} [${profile.platform}]`,
      detail: spawnDetail(ctx, role),
      group: "Agents",
      keywords: ["spawn", "agent", role],
      enabled: (c) => spawnAllowed(c, role),
      run: (c) => {
        const command = profile.command ?? topologyCommand(c, role) ?? process.env.SHELL ?? "bash";
        c.spawn(role, command, c.parentAgentId);
      },
    });
  }
  for (const role of ctx.topology?.roles ?? []) {
    if (profileRoles.has(role.name)) continue;
    const name = role.name;
    actions.push({
      id: `agent.spawn.${name}`,
      label: `Spawn ${name}`,
      detail: spawnDetail(ctx, name),
      group: "Agents",
      keywords: ["spawn", "agent", name],
      enabled: (c) => spawnAllowed(c, name),
      run: (c) => c.spawn(name, role.command ?? process.env.SHELL ?? "bash", c.parentAgentId),
    });
  }
  return actions;
};

export const killSource: DynamicSource = (ctx) =>
  ctx.sessions.map((session) => ({
    id: `agent.kill.${session}`,
    label: `Kill ${session}`,
    detail: "running",
    group: "Agents",
    keywords: ["kill", "stop", "agent"],
    run: (c) => c.kill(session),
  }));

export const delegateSource: DynamicSource = (ctx) =>
  ctx.gossipPeers
    .filter((peer) => peer.freeSlots > 0)
    .map((peer) => ({
      id: `agent.delegate.${peer.address}`,
      label: `Delegate to ${peer.peerId} (${peer.freeSlots} free)`,
      detail: "delegate",
      group: "Agents",
      keywords: ["delegate", "peer"],
      available: (c) => c.canDelegate,
      run: (c) => c.delegate(peer.address),
    }));

function spawnAllowed(ctx: ActionContext, role: string): boolean {
  if (!ctx.topology) return true; // no topology constraints to enforce
  if (ctx.claims === null) return false; // scoped session: conservative
  return checkSpawn(ctx.topology, role, ctx.claims, ctx.parentAgentId).allowed;
}

/**
 * Capacity/edge summary shown next to a spawn action, e.g. "1/3 → reviewer".
 * Falls back to "spawn" when topology constraints can't be evaluated (no
 * topology, or scoped session where claims are unavailable).
 */
function spawnDetail(ctx: ActionContext, role: string): string {
  if (!ctx.topology || ctx.claims === null) return "spawn";
  const check = checkSpawn(ctx.topology, role, ctx.claims, ctx.parentAgentId);
  const max = check.maxInstances !== undefined ? String(check.maxInstances) : "∞";
  const suffix = !check.allowed ? " (at capacity)" : "";
  const edges = ctx.topology.roles.find((r) => r.name === role)?.edges;
  const edgeSuffix = edges && edges.length > 0 ? ` → ${edges.map((e) => e.target).join(", ")}` : "";
  return `${check.currentInstances}/${max}${suffix}${edgeSuffix}`;
}

function topologyCommand(ctx: ActionContext, role: string): string | undefined {
  return ctx.topology?.roles.find((r) => r.name === role)?.command;
}
