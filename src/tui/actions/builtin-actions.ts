import { CORE_PANELS, OPERATOR_PANELS, PANEL_LABELS, Panel } from "../hooks/use-panel-focus.js";
import type { Action, ActionContext } from "./types.js";

/**
 * Build the full set of built-in STATIC actions. Per-entity actions (session
 * nav, spawn, kill, delegate) live in dynamic-sources.ts; the `ctx` parameter is
 * retained so callers can pass a snapshot, but the static set ignores it.
 */
export function buildBuiltInActions(_ctx: ActionContext): readonly Action[] {
  return Object.freeze([
    ...navigationActions(),
    ...focusedPanelActions(),
    ...agentActions(),
    ...workflowActions(),
    ...viewActions(),
    ...contributionActions(),
    ...keymapMigratedActions(),
  ]);
}

/**
 * Actions migrated from the legacy keymap dispatch switch (#275). Each is thin —
 * it delegates to a capability on the context. Focus gates are expressed via
 * `available`, which the keymap dispatcher treats as "not handled" so the old
 * focus-gate fall-through behavior is preserved.
 */
function keymapMigratedActions(): readonly Action[] {
  const actions: Action[] = [
    {
      id: "view.palette",
      label: "Open command palette",
      detail: "view",
      group: "View",
      keywords: ["palette", "command"],
      suggested: true,
      run: (c) => c.openPalette(),
    },
    {
      id: "nav.terminal.input",
      label: "Enter terminal input",
      detail: "terminal",
      group: "Navigation",
      keywords: ["terminal", "input", "type"],
      available: (c) => c.focusedPanel === Panel.Terminal,
      run: (c) => c.enterTerminalInput(),
    },
    {
      id: "artifact.prev",
      label: "Previous artifact",
      detail: "artifact",
      group: "View",
      available: (c) => c.focusedPanel === Panel.Artifact,
      run: (c) => c.artifactPrev(),
    },
    {
      id: "artifact.next",
      label: "Next artifact",
      detail: "artifact",
      group: "View",
      available: (c) => c.focusedPanel === Panel.Artifact,
      run: (c) => c.artifactNext(),
    },
    {
      id: "artifact.diff",
      label: "Toggle artifact diff",
      detail: "artifact",
      group: "View",
      available: (c) => c.focusedPanel === Panel.Artifact,
      run: (c) => c.artifactDiffToggle(),
    },
    {
      id: "artifact.diff-mode",
      label: "Cycle artifact diff mode",
      detail: "artifact",
      group: "View",
      available: (c) => c.focusedPanel === Panel.Artifact,
      run: (c) => c.artifactDiffModeToggle(),
    },
    {
      id: "nav.cursor-down",
      label: "Move cursor down",
      detail: "nav",
      group: "Navigation",
      run: (c) => c.cursorDown(),
    },
    {
      id: "nav.cursor-up",
      label: "Move cursor up",
      detail: "nav",
      group: "Navigation",
      run: (c) => c.cursorUp(),
    },
    {
      id: "nav.select",
      label: "Select row",
      detail: "nav",
      group: "Navigation",
      run: (c) => c.selectRow(),
    },
    {
      id: "nav.page-next",
      label: "Next page",
      detail: "nav",
      group: "Navigation",
      run: (c) => c.pageNext(),
    },
    {
      id: "nav.page-prev",
      label: "Previous page",
      detail: "nav",
      group: "Navigation",
      run: (c) => c.pagePrev(),
    },
    {
      id: "nav.vfs-navigate",
      label: "Open VFS entry",
      detail: "vfs",
      group: "Navigation",
      available: (c) => c.focusedPanel === Panel.Vfs,
      run: (c) => c.vfsNavigate(),
    },
    {
      id: "nav.terminal.scroll-up",
      label: "Scroll terminal up",
      detail: "terminal",
      group: "Navigation",
      available: (c) => c.focusedPanel === Panel.Terminal,
      run: (c) => c.terminalScrollUp(),
    },
    {
      id: "nav.terminal.scroll-down",
      label: "Scroll terminal down",
      detail: "terminal",
      group: "Navigation",
      available: (c) => c.focusedPanel === Panel.Terminal,
      run: (c) => c.terminalScrollDown(),
    },
    {
      id: "workflow.compare-select",
      label: "Select for compare",
      detail: "compare",
      group: "Workflow",
      available: (c) => c.focusedPanel === Panel.Frontier,
      run: (c) => c.compareSelect(),
    },
    {
      id: "workflow.compare-adopt-a",
      label: "Adopt compare A",
      detail: "compare",
      group: "Workflow",
      available: (c) => c.focusedPanel === Panel.Artifact,
      run: (c) => c.compareAdoptA(),
    },
    {
      id: "workflow.compare-adopt-b",
      label: "Adopt compare B",
      detail: "compare",
      group: "Workflow",
      available: (c) => c.focusedPanel === Panel.Artifact,
      run: (c) => c.compareAdoptB(),
    },
    {
      id: "contrib.frontier-adopt",
      label: "Adopt frontier entry",
      detail: "frontier",
      group: "Contributions",
      keywords: ["adopt", "frontier"],
      available: (c) => c.focusedPanel === Panel.Frontier,
      run: (c) => c.frontierAdopt(),
    },
  ];
  return actions;
}

function navigationActions(): readonly Action[] {
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

/**
 * Static agent actions. Per-entity spawn/kill/delegate actions are emitted by
 * the dynamic sources in dynamic-sources.ts; only the always-present messaging
 * actions remain here.
 */
function agentActions(): readonly Action[] {
  return [
    {
      id: "agent.broadcast",
      label: "Broadcast message to all agents",
      detail: "message",
      group: "Agents",
      keywords: ["message", "broadcast", "all", "tell"],
      slash: "/broadcast",
      run: (c) => c.broadcastMessage(),
    },
    {
      id: "agent.direct-message",
      label: "Direct message an agent",
      detail: "message",
      group: "Agents",
      keywords: ["message", "direct", "dm", "tell"],
      slash: "/dm",
      run: (c) => c.directMessage(),
    },
  ];
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
      slash: "/refresh",
      run: (c) => c.refresh(),
    },
    {
      id: "view.search",
      label: "Search transcripts",
      detail: "view",
      group: "View",
      keywords: ["search", "find", "filter"],
      slash: "/search",
      suggested: true,
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
      slash: "/help",
      run: (c) => c.showHelp(),
    },
    {
      id: "view.quit",
      label: "Quit grove",
      detail: "view",
      group: "View",
      keywords: ["quit", "exit", "close"],
      slash: "/quit",
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
      slash: "/goal",
      suggested: true,
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
      slash: "/compare",
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
