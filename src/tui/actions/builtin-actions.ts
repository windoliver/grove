import { checkSpawn } from "../agents/spawn-validator.js";
import { OPERATOR_PANELS, PANEL_LABELS, type Panel } from "../hooks/use-panel-focus.js";
import type { Action, ActionContext } from "./types.js";

/** Build the full set of built-in actions from the current context. */
export function buildBuiltInActions(ctx: ActionContext): readonly Action[] {
  return Object.freeze([
    ...navigationActions(ctx),
    ...agentActions(ctx),
    ...workflowActions(ctx),
    ...contributionActions(),
  ]);
}

function navigationActions(ctx: ActionContext): readonly Action[] {
  const actions: Action[] = [];
  for (const panel of OPERATOR_PANELS) {
    const label = PANEL_LABELS[panel];
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    actions.push({
      id: `nav.panel.${key}`,
      label: `Go to ${label} panel`,
      detail: "panel",
      group: "Navigation",
      keywords: ["open", "focus", "panel", label],
      run: (c) =>
        c.isPanelVisible(panel as Panel)
          ? c.focusPanel(panel as Panel)
          : c.togglePanel(panel as Panel),
    });
  }
  for (const session of ctx.sessions) {
    actions.push({
      id: `nav.session.${session}`,
      label: `Jump to session ${session}`,
      detail: "session",
      group: "Navigation",
      keywords: ["session", "agent", "jump"],
      run: (c) => c.jumpToSession(session),
    });
  }
  return actions;
}

function agentActions(ctx: ActionContext): readonly Action[] {
  const actions: Action[] = [];

  // Spawn from profiles first, then topology roles not covered by a profile.
  const profileRoles = new Set<string>();
  if (ctx.canSpawn) {
    for (const profile of ctx.profiles) {
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
          const command =
            profile.command ?? topologyCommand(c, role) ?? process.env.SHELL ?? "bash";
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
  }

  for (const session of ctx.sessions) {
    actions.push({
      id: `agent.kill.${session}`,
      label: `Kill ${session}`,
      detail: "running",
      group: "Agents",
      keywords: ["kill", "stop", "agent"],
      run: (c) => c.kill(session),
    });
  }

  for (const peer of ctx.gossipPeers) {
    if (peer.freeSlots <= 0) continue;
    actions.push({
      id: `agent.delegate.${peer.address}`,
      label: `Delegate to ${peer.peerId} (${peer.freeSlots} free)`,
      detail: "delegate",
      group: "Agents",
      keywords: ["delegate", "peer"],
      available: (c) => c.canDelegate,
      run: (c) => c.delegate(peer.address),
    });
  }

  return actions;
}

function workflowActions(ctx: ActionContext): readonly Action[] {
  void ctx;
  return [
    {
      id: "workflow.set-goal",
      label: "Set goal",
      detail: "Set or update the session goal for all agents",
      group: "Workflow",
      keywords: ["goal", "objective"],
      available: (c) => c.hasGoals,
      run: (c) => c.enterGoalMode(),
    },
    {
      id: "workflow.approve-question",
      label: "Approve pending question",
      detail: "approvals",
      group: "Workflow",
      keywords: ["answer", "approve", "question", "ask"],
      available: (c) => c.pendingQuestionCount > 0,
      run: (c) => c.answerPendingQuestion("approve"),
    },
    {
      id: "workflow.deny-question",
      label: "Deny pending question",
      detail: "approvals",
      group: "Workflow",
      keywords: ["answer", "deny", "question", "ask"],
      available: (c) => c.pendingQuestionCount > 0,
      run: (c) => c.answerPendingQuestion("deny"),
    },
    {
      id: "workflow.compare",
      label: "Compare contributions",
      detail: "compare",
      group: "Workflow",
      keywords: ["compare", "diff"],
      run: (c) => c.enterCompareMode(),
    },
    {
      id: "workflow.register-agent",
      label: "Register new agent profile",
      detail: "agents.json",
      group: "Workflow",
      keywords: ["register", "profile"],
      run: (c) => c.registerAgentProfile(),
    },
  ];
}

function contributionActions(): readonly Action[] {
  const hasSelection = (c: ActionContext) => c.selectedCid !== undefined;
  return [
    {
      id: "contrib.open",
      label: "Open selected contribution",
      detail: "inspect",
      group: "Contributions",
      keywords: ["open", "detail", "contribution"],
      available: hasSelection,
      run: (c) => {
        if (c.selectedCid) c.openContribution(c.selectedCid);
      },
    },
    {
      id: "contrib.compare-add",
      label: "Add selected contribution to compare",
      detail: "compare",
      group: "Contributions",
      keywords: ["compare", "add"],
      available: hasSelection,
      run: (c) => {
        if (c.selectedCid) c.addToCompare(c.selectedCid);
      },
    },
    {
      id: "contrib.adopt",
      label: "Adopt selected contribution",
      detail: "adopt",
      group: "Contributions",
      keywords: ["adopt", "build on"],
      available: hasSelection,
      run: (c) => {
        if (c.selectedCid) c.adoptContribution(c.selectedCid, "");
      },
    },
  ];
}

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
