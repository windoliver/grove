import { describe, expect, test } from "bun:test";
import { routeKey, type SupervisionAction, type SupervisionContext } from "./keyboard.js";

function ctx(over: Partial<SupervisionContext> = {}): SupervisionContext {
  return {
    modalOpen: false,
    focusedAgentAwaiting: false,
    drillOpen: false,
    cmdMode: "idle",
    ...over,
  };
}

describe("routeKey", () => {
  describe("modal open", () => {
    test("y → accept-approval", () => {
      expect(routeKey("y", ctx({ modalOpen: true }))).toEqual<SupervisionAction>(
        { kind: "accept-approval" },
      );
    });
    test("n → reject-approval", () => {
      expect(routeKey("n", ctx({ modalOpen: true }))).toEqual<SupervisionAction>(
        { kind: "reject-approval" },
      );
    });
    test("d → toggle-approval-detail", () => {
      expect(routeKey("d", ctx({ modalOpen: true }))).toEqual<SupervisionAction>(
        { kind: "toggle-approval-detail" },
      );
    });
    test("Escape → close-modal", () => {
      expect(routeKey("Escape", ctx({ modalOpen: true }))).toEqual<SupervisionAction>(
        { kind: "close-modal" },
      );
    });
    test("hjkl ignored while modal open", () => {
      expect(routeKey("j", ctx({ modalOpen: true }))).toBeUndefined();
    });
  });

  describe("modal closed, focused card awaiting", () => {
    test("y → accept-focused-approval", () => {
      expect(routeKey("y", ctx({ focusedAgentAwaiting: true }))).toEqual<SupervisionAction>(
        { kind: "accept-focused-approval" },
      );
    });
    test("n → reject-focused-approval", () => {
      expect(routeKey("n", ctx({ focusedAgentAwaiting: true }))).toEqual<SupervisionAction>(
        { kind: "reject-focused-approval" },
      );
    });
  });

  describe("grid navigation (default precedence)", () => {
    test("h j k l move cursor", () => {
      expect(routeKey("h", ctx())).toEqual<SupervisionAction>({ kind: "cursor-left" });
      expect(routeKey("j", ctx())).toEqual<SupervisionAction>({ kind: "cursor-down" });
      expect(routeKey("k", ctx())).toEqual<SupervisionAction>({ kind: "cursor-up" });
      expect(routeKey("l", ctx())).toEqual<SupervisionAction>({ kind: "cursor-right" });
    });
    test("g G top/bottom", () => {
      expect(routeKey("g", ctx())).toEqual<SupervisionAction>({ kind: "cursor-top" });
      expect(routeKey("G", ctx())).toEqual<SupervisionAction>({ kind: "cursor-bottom" });
    });
    test("Enter / o open drill", () => {
      expect(routeKey("Enter", ctx())).toEqual<SupervisionAction>({ kind: "open-drill" });
      expect(routeKey("o", ctx())).toEqual<SupervisionAction>({ kind: "open-drill" });
    });
    test("A → open-next-approval", () => {
      expect(routeKey("A", ctx())).toEqual<SupervisionAction>({ kind: "open-next-approval" });
    });
    test("/ → enter-filter", () => {
      expect(routeKey("/", ctx())).toEqual<SupervisionAction>({ kind: "enter-filter" });
    });
    test("s → cycle-sort", () => {
      expect(routeKey("s", ctx())).toEqual<SupervisionAction>({ kind: "cycle-sort" });
    });
    test("f → cycle-state-filter", () => {
      expect(routeKey("f", ctx())).toEqual<SupervisionAction>({ kind: "cycle-state-filter" });
    });
    test("c → copy-agent-id", () => {
      expect(routeKey("c", ctx())).toEqual<SupervisionAction>({ kind: "copy-agent-id" });
    });
  });

  describe("drill open", () => {
    test("Tab cycles drill tab", () => {
      expect(routeKey("Tab", ctx({ drillOpen: true }))).toEqual<SupervisionAction>(
        { kind: "cycle-drill-tab" },
      );
    });
    test("1/2/3 jump to drill tab Feed/DAG/Term", () => {
      expect(routeKey("1", ctx({ drillOpen: true }))).toEqual<SupervisionAction>(
        { kind: "set-drill-tab", tab: "feed" },
      );
      expect(routeKey("2", ctx({ drillOpen: true }))).toEqual<SupervisionAction>(
        { kind: "set-drill-tab", tab: "dag" },
      );
      expect(routeKey("3", ctx({ drillOpen: true }))).toEqual<SupervisionAction>(
        { kind: "set-drill-tab", tab: "term" },
      );
    });
    test("4 is unbound (no fourth drill tab)", () => {
      expect(routeKey("4", ctx({ drillOpen: true }))).toBeUndefined();
    });
    test("Escape collapses drill", () => {
      expect(routeKey("Escape", ctx({ drillOpen: true }))).toEqual<SupervisionAction>(
        { kind: "close-drill" },
      );
    });
  });

  describe("cmdMode filter", () => {
    test("Escape exits filter mode", () => {
      expect(routeKey("Escape", ctx({ cmdMode: "filter" }))).toEqual<SupervisionAction>(
        { kind: "exit-cmd-mode" },
      );
    });
    test("character keys feed into filter input", () => {
      expect(routeKey("a", ctx({ cmdMode: "filter" }))).toEqual<SupervisionAction>(
        { kind: "cmd-mode-char", char: "a" },
      );
    });
  });
});
