import {
  CORE_PANELS,
  OPERATOR_PANELS,
  Panel,
  type Panel as PanelValue,
} from "../hooks/use-panel-focus.js";

export const PanelId = {
  Dag: "dag",
  Detail: "detail",
  Frontier: "frontier",
  Claims: "claims",
  AgentList: "agents",
  Terminal: "terminal",
  Artifact: "artifact",
  Vfs: "vfs",
  Activity: "activity",
  Search: "search",
  Threads: "threads",
  Outcomes: "outcomes",
  Bounties: "bounties",
  Gossip: "gossip",
  Inbox: "inbox",
  Decisions: "decisions",
  GitHub: "github",
  Plan: "plan",
} as const;

export type BuiltInPanelId = (typeof PanelId)[keyof typeof PanelId];

const PANEL_TO_ID: Readonly<Record<PanelValue, BuiltInPanelId>> = {
  [Panel.Dag]: PanelId.Dag,
  [Panel.Detail]: PanelId.Detail,
  [Panel.Frontier]: PanelId.Frontier,
  [Panel.Claims]: PanelId.Claims,
  [Panel.AgentList]: PanelId.AgentList,
  [Panel.Terminal]: PanelId.Terminal,
  [Panel.Artifact]: PanelId.Artifact,
  [Panel.Vfs]: PanelId.Vfs,
  [Panel.Activity]: PanelId.Activity,
  [Panel.Search]: PanelId.Search,
  [Panel.Threads]: PanelId.Threads,
  [Panel.Outcomes]: PanelId.Outcomes,
  [Panel.Bounties]: PanelId.Bounties,
  [Panel.Gossip]: PanelId.Gossip,
  [Panel.Inbox]: PanelId.Inbox,
  [Panel.Decisions]: PanelId.Decisions,
  [Panel.GitHub]: PanelId.GitHub,
  [Panel.Plan]: PanelId.Plan,
};

const ID_TO_PANEL = new Map<BuiltInPanelId, PanelValue>(
  Object.entries(PANEL_TO_ID).map(([panel, id]) => [id, Number(panel) as PanelValue]),
);

export const CORE_PANEL_IDS: readonly BuiltInPanelId[] = CORE_PANELS.map(
  (panel) => PANEL_TO_ID[panel],
);
export const OPERATOR_PANEL_IDS: readonly BuiltInPanelId[] = OPERATOR_PANELS.map(
  (panel) => PANEL_TO_ID[panel],
);
export const BUILT_IN_PANEL_IDS: readonly BuiltInPanelId[] = [
  ...CORE_PANEL_IDS,
  ...OPERATOR_PANEL_IDS,
];

export function panelToId(panel: PanelValue): BuiltInPanelId {
  return PANEL_TO_ID[panel];
}

export function idToPanel(id: string): PanelValue | undefined {
  return ID_TO_PANEL.get(id as BuiltInPanelId);
}
