import { checkSpawn } from "../agents/spawn-validator.js";
import { CORE_PANELS, OPERATOR_PANELS, PANEL_LABELS, Panel } from "../hooks/use-panel-focus.js";
import type { Action, ActionContext } from "./types.js";

/** Build the full set of built-in actions from the current context. */
export function buildBuiltInActions(ctx: ActionContext): readonly Action[] {
  return Object.freeze([
    ...navigationActions(ctx),
    ...focusedPanelActions(),
    ...agentActions(ctx),
    ...workflowActions(),
    ...viewActions(),
    ...contributionActions(),
  ]);
}

function navigationActions(ctx: ActionContext): readonly Action[] {
  const actions: Action[] = [];
  // Core panels are always visible (focus only); operator panels open-or-focus.
  for (const panel of [...CORE_PANELS, ...OPERATOR_PANELS]) {
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
  actions.push(
    {
      id: "nav.panel.next",
      label: "Cycle to next panel",
      detail: "panel",
      group: "Navigation",
      keywords: ["panel", "next", "cycle", "tab"],
      run: (c) => c.cyclePanelNext(),
    },
    {
      id: "nav.panel.prev",
      label: "Cycle to previous panel",
      detail: "panel",
      group: "Navigation",
      keywords: ["panel", "previous", "cycle"],
      run: (c) => c.cyclePanelPrev(),
    },
  );
  return actions;
}

function agentActions(ctx: ActionContext): readonly Action[] {
  const actions: Action[] = [];

  // Spawn from profiles first, then topology roles not covered by a profile.
  const profileRoles = new Set<string>();
  if (ctx.canSpawn) {
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

  actions.push(
    {
      id: "agent.broadcast",
      label: "Broadcast message to all agents",
      detail: "message",
      group: "Agents",
      keywords: ["message", "broadcast", "all", "tell"],
      run: (c) => c.broadcastMessage(),
    },
    {
      id: "agent.direct-message",
      label: "Direct message an agent",
      detail: "message",
      group: "Agents",
      keywords: ["message", "direct", "dm", "tell"],
      run: (c) => c.directMessage(),
    },
  );

  return actions;
}

/**
 * Actions that only make sense for the currently focused panel. They are hidden
 * (via `available`) unless the relevant panel holds focus.
 */
function focusedPanelActions(): readonly Action[] {
  return [
    {
      id: "nav.frontier.next-slice",
      label: "Next frontier slice",
      detail: "frontier",
      group: "Navigation",
      keywords: ["frontier", "slice", "tab", "next"],
      available: (c) => c.focusedPanel === Panel.Frontier && c.frontierSliceCount > 1,
      run: (c) => c.nextFrontierSlice(),
    },
    {
      id: "nav.frontier.prev-slice",
      label: "Previous frontier slice",
      detail: "frontier",
      group: "Navigation",
      keywords: ["frontier", "slice", "tab", "previous"],
      available: (c) => c.focusedPanel === Panel.Frontier && c.frontierSliceCount > 1,
      run: (c) => c.prevFrontierSlice(),
    },
    {
      id: "nav.terminal.scroll-bottom",
      label: "Scroll terminal to bottom",
      detail: "terminal",
      group: "Navigation",
      keywords: ["terminal", "scroll", "bottom"],
      available: (c) => c.focusedPanel === Panel.Terminal,
      run: (c) => c.scrollTerminalToBottom(),
    },
  ];
}

/** Global view / system actions. */
function viewActions(): readonly Action[] {
  return [
    {
      id: "view.refresh",
      label: "Refresh all data",
      detail: "view",
      group: "View",
      keywords: ["refresh", "reload", "update"],
      run: (c) => c.refresh(),
    },
    {
      id: "view.search",
      label: "Search transcripts",
      detail: "view",
      group: "View",
      keywords: ["search", "find", "filter"],
      run: (c) => c.enterSearch(),
    },
    {
      id: "view.zoom",
      label: "Cycle zoom level",
      detail: "view",
      group: "View",
      keywords: ["zoom", "focus", "expand"],
      run: (c) => c.cycleZoom(),
    },
    {
      id: "view.zoom-reset",
      label: "Reset zoom",
      detail: "view",
      group: "View",
      keywords: ["zoom", "reset", "normal"],
      run: (c) => c.resetZoom(),
    },
    {
      id: "view.layout",
      label: "Toggle layout (grid/tab)",
      detail: "view",
      group: "View",
      keywords: ["layout", "grid", "tab", "toggle"],
      run: (c) => c.toggleLayout(),
    },
    {
      id: "view.view-mode",
      label: "Cycle view mode (grid/pipeline)",
      detail: "view",
      group: "View",
      keywords: ["view", "pipeline", "grid", "mode", "cycle"],
      run: (c) => c.cycleViewMode(),
    },
    {
      id: "view.help",
      label: "Show help",
      detail: "view",
      group: "View",
      keywords: ["help", "keys", "shortcuts", "?"],
      run: (c) => c.showHelp(),
    },
    {
      id: "view.quit",
      label: "Quit grove",
      detail: "view",
      group: "View",
      keywords: ["quit", "exit", "close"],
      run: (c) => c.quit(),
    },
  ];
}

function workflowActions(): readonly Action[] {
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
    // Approve/deny are offered ONLY when exactly one question is pending — then
    // there is no ambiguity about which one is answered. With multiple pending,
    // a blind global answer could unblock the wrong prompt, so we route the
    // operator to the Decisions panel (cursor-scoped) instead.
    {
      id: "workflow.approve-question",
      label: "Approve pending question",
      detail: "approvals",
      group: "Workflow",
      keywords: ["answer", "approve", "question", "ask"],
      available: (c) => c.pendingQuestionCount === 1,
      run: (c) => c.answerPendingQuestion("approve", c.pendingQuestionCid),
    },
    {
      id: "workflow.deny-question",
      label: "Deny pending question",
      detail: "approvals",
      group: "Workflow",
      keywords: ["answer", "deny", "question", "ask"],
      available: (c) => c.pendingQuestionCount === 1,
      run: (c) => c.answerPendingQuestion("deny", c.pendingQuestionCid),
    },
    {
      id: "workflow.review-questions",
      label: "Review pending questions",
      detail: "approvals",
      group: "Workflow",
      keywords: ["answer", "question", "ask", "decisions", "review", "approvals"],
      // Multiple pending → don't blind-answer; open the Decisions panel where
      // the cursor selects exactly which question to approve/deny.
      available: (c) => c.pendingQuestionCount > 1,
      run: (c) =>
        c.isPanelVisible(Panel.Decisions)
          ? c.focusPanel(Panel.Decisions)
          : c.togglePanel(Panel.Decisions),
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
      // Greyed when the highlighted contribution is already the open detail —
      // re-opening it would just push a duplicate nav entry.
      enabled: (c) => c.selectedCid !== c.detailCid,
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
        if (c.selectedCid) c.adoptContribution(c.selectedCid);
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
