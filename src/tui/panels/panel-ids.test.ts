import { describe, expect, test } from "bun:test";
import { Panel } from "../hooks/use-panel-focus.js";
import {
  BUILT_IN_PANEL_IDS,
  CORE_PANEL_IDS,
  idToPanel,
  OPERATOR_PANEL_IDS,
  PanelId,
  panelToId,
} from "./panel-ids.js";

describe("panel IDs", () => {
  test("keeps stable string IDs for all built-in panels", () => {
    expect(PanelId.Dag).toBe("dag");
    expect(PanelId.Detail).toBe("detail");
    expect(PanelId.Frontier).toBe("frontier");
    expect(PanelId.Claims).toBe("claims");
    expect(PanelId.AgentList).toBe("agents");
    expect(PanelId.Terminal).toBe("terminal");
    expect(PanelId.Artifact).toBe("artifact");
    expect(PanelId.Vfs).toBe("vfs");
    expect(PanelId.Activity).toBe("activity");
    expect(PanelId.Search).toBe("search");
    expect(PanelId.Threads).toBe("threads");
    expect(PanelId.Outcomes).toBe("outcomes");
    expect(PanelId.Bounties).toBe("bounties");
    expect(PanelId.Gossip).toBe("gossip");
    expect(PanelId.Inbox).toBe("inbox");
    expect(PanelId.Decisions).toBe("decisions");
    expect(PanelId.GitHub).toBe("github");
    expect(PanelId.Plan).toBe("plan");
  });

  test("converts numeric Panel values to stable string IDs", () => {
    expect(panelToId(Panel.Dag)).toBe(PanelId.Dag);
    expect(panelToId(Panel.AgentList)).toBe(PanelId.AgentList);
    expect(panelToId(Panel.GitHub)).toBe(PanelId.GitHub);
  });

  test("converts stable string IDs back to numeric Panel values", () => {
    expect(idToPanel("dag")).toBe(Panel.Dag);
    expect(idToPanel("agents")).toBe(Panel.AgentList);
    expect(idToPanel("github")).toBe(Panel.GitHub);
  });

  test("returns undefined for unknown string IDs", () => {
    expect(idToPanel("missing")).toBeUndefined();
    expect(idToPanel("bad/id")).toBeUndefined();
  });

  test("exports ordered built-in, core, and operator ID lists", () => {
    expect(CORE_PANEL_IDS).toEqual(["dag", "detail", "frontier", "claims"]);
    expect(OPERATOR_PANEL_IDS[0]).toBe("agents");
    expect(OPERATOR_PANEL_IDS[OPERATOR_PANEL_IDS.length - 1]).toBe("plan");
    expect(BUILT_IN_PANEL_IDS).toEqual([...CORE_PANEL_IDS, ...OPERATOR_PANEL_IDS]);
  });
});
