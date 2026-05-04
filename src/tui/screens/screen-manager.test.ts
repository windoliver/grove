/**
 * ScreenManager transition tests.
 *
 * These tests mount the real ScreenManager state machine with mocked provider,
 * topology, and SpawnManager dependencies. Most child screens are thin probes
 * that expose transition callbacks; GoalInput stays real so Enter-on-empty
 * validation is exercised through its keyboard handler.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { Contribution } from "../../core/models.js";
import { ContributionKind, ContributionMode } from "../../core/models.js";
import type { AgentTopology } from "../../core/topology.js";
import type { AppProps } from "../app.js";
import type {
  DashboardData,
  GoalData,
  ProviderCapabilities,
  SessionInput,
  SessionRecord,
  TuiDataProvider,
  TuiGoalProvider,
  TuiSessionProvider,
} from "../provider.js";
import type { SpawnManager, SpawnResult } from "../spawn-manager.js";
import { SpawnManagerContext } from "../spawn-manager-context.js";
import type { TuiPresetEntry } from "../tui-app.js";
import type { AgentDetectProps } from "./agent-detect.js";
import type { CompleteViewProps } from "./complete-view.js";
import type { PresetSelectProps } from "./preset-select.js";
import type { RunningViewProps } from "./running-view.js";
import type { ScreenManagerProps, ScreenState } from "./screen-manager.js";
import type { SpawnProgressProps } from "./spawn-progress.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type KeyboardKey = {
  readonly name?: string | undefined;
  readonly sequence?: string | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
};
type KeyboardHandler = (key: KeyboardKey) => void;

interface CapturedScreens {
  screen?: "preset-select" | "launch-preview" | "spawning" | "running" | "complete";
  presetSelect?: PresetSelectProps;
  launchPreview?: AgentDetectProps;
  spawnProgress?: SpawnProgressProps;
  runningView?: RunningViewProps;
  completeView?: CompleteViewProps;
}

interface TestProvider extends TuiDataProvider, TuiGoalProvider, TuiSessionProvider {
  setSessionScope(sessionId: string): void;
}

interface ProviderCalls {
  readonly createSession: SessionInput[];
  readonly setGoal: string[];
  readonly archiveSession: string[];
  readonly setSessionScope: string[];
  readonly addContributionToSession: { readonly sessionId: string; readonly cid: string }[];
}

interface ProviderBundle {
  readonly provider: TestProvider;
  readonly calls: ProviderCalls;
}

interface SpawnCall {
  readonly roleId: string;
  readonly command: string;
  readonly context?: Record<string, unknown> | undefined;
}

interface TestSpawnManager {
  readonly spawnCalls: SpawnCall[];
  readonly sessionIds: string[];
  readonly sessionGoals: string[];
  readonly topologies: AgentTopology[];
  readonly ensuredBuffers: string[];
  readonly reconcileCalls: string[];
  readonly saveTraceCalls: string[];
  readonly stopLogPollingCalls: string[];
  reconcile(): Promise<void>;
  ensureLogBuffer(roleName: string): void;
  getLogBuffers(): Map<string, unknown>;
  startLogPolling(intervalMs?: number, seekToEnd?: boolean): void;
  stopLogPolling(): void;
  setSessionId(sessionId: string): void;
  loadTraces(sessionId: string): Promise<void>;
  saveTraces(): Promise<void>;
  setSessionGoal(goal: string): void;
  setTopology(topology: AgentTopology): void;
  spawn(
    roleId: string,
    command: string,
    parentAgentId?: string,
    depth?: number,
    context?: Record<string, unknown>,
  ): Promise<SpawnResult>;
  getActiveRoles(): readonly string[];
  sendToAgent(role: string, message: string): Promise<boolean>;
}

let captured: CapturedScreens = {};
let keyboardHandler: KeyboardHandler | undefined;
let rendererDestroy = mock(() => undefined);

mock.module("@opentui/react", () => ({
  useKeyboard: (handler: KeyboardHandler): void => {
    keyboardHandler = handler;
  },
  useRenderer: (): { destroy: () => void } => ({
    destroy: rendererDestroy,
  }),
  useTerminalDimensions: (): { width: number; height: number } => ({
    width: 120,
    height: 40,
  }),
  useTimeline: (): { add: () => unknown; play: () => unknown } => ({
    add: () => ({ add: () => ({ play: () => undefined }), play: () => undefined }),
    play: () => undefined,
  }),
}));

mock.module("../hooks/use-permission-detection.js", () => ({
  usePermissionDetection: (): readonly unknown[] => [],
}));

mock.module("./preset-select.js", () => ({
  PresetSelect: (props: PresetSelectProps): React.ReactNode => {
    captured = { ...captured, screen: "preset-select", presetSelect: props };
    return null;
  },
}));

mock.module("./agent-detect.js", () => ({
  AgentDetect: (props: AgentDetectProps): React.ReactNode => {
    captured = { ...captured, screen: "launch-preview", launchPreview: props };
    return null;
  },
}));

mock.module("./spawn-progress.js", () => ({
  SpawnProgress: (props: SpawnProgressProps): React.ReactNode => {
    captured = { ...captured, screen: "spawning", spawnProgress: props };
    return null;
  },
}));

mock.module("./running-view.js", () => ({
  RunningView: (props: RunningViewProps): React.ReactNode => {
    captured = { ...captured, screen: "running", runningView: props };
    return null;
  },
}));

mock.module("./complete-view.js", () => ({
  CompleteView: (props: CompleteViewProps): React.ReactNode => {
    captured = { ...captured, screen: "complete", completeView: props };
    return null;
  },
}));

const { ScreenManager } = await import("./screen-manager.js");

const ALL_CAPABILITIES_FALSE: ProviderCapabilities = {
  outcomes: false,
  artifacts: false,
  vfs: false,
  messaging: false,
  costTracking: false,
  askUser: false,
  github: false,
  bounties: false,
  gossip: false,
  goals: false,
  sessions: false,
  handoffs: false,
};

const TEST_TOPOLOGY: AgentTopology = {
  structure: "graph",
  roles: [
    {
      name: "planner",
      description: "Plans the work",
      command: "codex",
      platform: "codex",
      edges: [{ target: "builder", edgeType: "delegates" }],
    },
    {
      name: "builder",
      description: "Builds the work",
      command: "claude",
      platform: "claude-code",
    },
  ],
  spawning: { dynamic: false },
};

const PRESETS: readonly TuiPresetEntry[] = [{ name: "review-loop", description: "Review loop" }];

const ACTIVE_SESSION: SessionRecord = {
  id: "session-active",
  goal: "Resume existing work",
  presetName: "review-loop",
  status: "active",
  createdAt: "2026-03-29T00:00:00.000Z",
  contributionCount: 0,
  topology: TEST_TOPOLOGY,
};

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  captured = {};
  keyboardHandler = undefined;
  rendererDestroy = mock(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedRenderers.splice(0)) {
      renderer.unmount();
    }
    await flushAsync();
  });
});

function makeContribution(cid: string): Contribution {
  return {
    cid,
    manifestVersion: 1,
    kind: ContributionKind.Work,
    mode: ContributionMode.Exploration,
    summary: cid,
    artifacts: {},
    relations: [],
    tags: [],
    agent: { agentId: "agent-1", role: "planner" },
    createdAt: "2026-03-29T00:00:00.000Z",
  };
}

function makeDashboard(): DashboardData {
  return {
    metadata: {
      name: "test-grove",
      contributionCount: 0,
      activeClaimCount: 0,
      mode: "local",
      backendLabel: "test",
    },
    activeClaims: [],
    recentContributions: [],
    frontierSummary: { topByMetric: [], topByAdoption: [] },
  };
}

function makeSession(input: SessionInput, id: string): SessionRecord {
  return {
    id,
    goal: input.goal,
    presetName: input.presetName,
    status: "active",
    createdAt: "2026-03-29T00:00:00.000Z",
    topology: input.topology,
    config: input.config,
    contributionCount: 0,
  };
}

function makeProvider(options?: {
  readonly capabilities?: Partial<ProviderCapabilities> | undefined;
  readonly contributions?: readonly Contribution[] | undefined;
}): ProviderBundle {
  const capabilities: ProviderCapabilities = {
    ...ALL_CAPABILITIES_FALSE,
    goals: true,
    sessions: true,
    ...options?.capabilities,
  };
  const calls: ProviderCalls = {
    createSession: [],
    setGoal: [],
    archiveSession: [],
    setSessionScope: [],
    addContributionToSession: [],
  };
  const provider: TestProvider = {
    capabilities,
    getDashboard: async () => makeDashboard(),
    getContributions: async () => options?.contributions ?? [],
    getContribution: async () => undefined,
    getClaims: async () => [],
    getFrontier: async () => ({
      byMetric: {},
      byAdoption: [],
      byRecency: [],
      byReviewScore: [],
      byReproduction: [],
    }),
    getActivity: async () => [],
    getDag: async () => ({ contributions: [] }),
    getHotThreads: async () => [],
    close: () => undefined,
    getGoal: async () => undefined,
    setGoal: async (goal: string): Promise<GoalData> => {
      calls.setGoal.push(goal);
      return {
        goal,
        acceptance: [],
        status: "active",
        setAt: "2026-03-29T00:00:00.000Z",
        setBy: "operator",
      };
    },
    listSessions: async () => [],
    createSession: async (input: SessionInput) => {
      calls.createSession.push(input);
      return makeSession(input, `session-${calls.createSession.length}`);
    },
    getSession: async (sessionId: string) =>
      sessionId === ACTIVE_SESSION.id ? ACTIVE_SESSION : undefined,
    archiveSession: async (sessionId: string) => {
      calls.archiveSession.push(sessionId);
    },
    addContributionToSession: async (sessionId: string, cid: string) => {
      calls.addContributionToSession.push({ sessionId, cid });
    },
    setSessionScope: (sessionId: string) => {
      calls.setSessionScope.push(sessionId);
    },
  };
  return { provider, calls };
}

function makeSpawnManager(): TestSpawnManager {
  const logBuffers = new Map<string, unknown>();
  const manager: TestSpawnManager = {
    spawnCalls: [],
    sessionIds: [],
    sessionGoals: [],
    topologies: [],
    ensuredBuffers: [],
    reconcileCalls: [],
    saveTraceCalls: [],
    stopLogPollingCalls: [],
    reconcile: async () => {
      manager.reconcileCalls.push("reconcile");
    },
    ensureLogBuffer: (roleName: string) => {
      manager.ensuredBuffers.push(roleName);
      logBuffers.set(roleName, {});
    },
    getLogBuffers: () => logBuffers,
    startLogPolling: () => undefined,
    stopLogPolling: () => {
      manager.stopLogPollingCalls.push("stop");
    },
    setSessionId: (sessionId: string) => {
      manager.sessionIds.push(sessionId);
    },
    loadTraces: async () => undefined,
    saveTraces: async () => {
      manager.saveTraceCalls.push("save");
    },
    setSessionGoal: (goal: string) => {
      manager.sessionGoals.push(goal);
    },
    setTopology: (topology: AgentTopology) => {
      manager.topologies.push(topology);
    },
    spawn: async (roleId, command, _parentAgentId, _depth, context) => {
      manager.spawnCalls.push({ roleId, command, context });
      return {
        spawnId: `${roleId}-spawn`,
        claimId: `${roleId}-claim`,
        workspacePath: `/tmp/${roleId}`,
        workspaceMode: {
          status: "isolated_worktree",
          path: `/tmp/${roleId}`,
          branch: `grove/test/${roleId}`,
        },
      };
    },
    getActiveRoles: () => manager.spawnCalls.map((call) => call.roleId),
    sendToAgent: async () => true,
  };
  return manager;
}

function makeAppProps(provider: TuiDataProvider, topology?: AgentTopology): AppProps {
  return {
    provider,
    intervalMs: 10,
    ...(topology ? { topology } : {}),
  };
}

function renderScreenManager(options?: {
  readonly appProps?: AppProps | undefined;
  readonly provider?: TestProvider | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly spawnManager?: TestSpawnManager | undefined;
  readonly presets?: readonly TuiPresetEntry[] | undefined;
  readonly sessions?: readonly SessionRecord[] | undefined;
  readonly startOnRunning?: boolean | undefined;
  readonly initialState?: ScreenState | undefined;
  readonly resumeSessionId?: string | undefined;
}): {
  readonly renderer: TestRenderer.ReactTestRenderer;
  readonly provider: TestProvider;
  readonly spawnManager: TestSpawnManager;
} {
  const provider = options?.provider ?? makeProvider().provider;
  const spawnManager = options?.spawnManager ?? makeSpawnManager();
  const appProps = options?.appProps ?? makeAppProps(provider, options?.topology);
  const props: ScreenManagerProps = {
    appProps,
    ...(options?.presets ? { presets: options.presets } : {}),
    ...(options?.sessions ? { sessions: options.sessions } : {}),
    ...(options?.startOnRunning !== undefined ? { startOnRunning: options.startOnRunning } : {}),
    ...(options?.initialState ? { initialState: options.initialState } : {}),
    ...(options?.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
  };

  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(
        SpawnManagerContext.Provider,
        { value: spawnManager as unknown as SpawnManager },
        React.createElement(ScreenManager, props),
      ),
    );
  });
  if (!renderer) {
    throw new Error("ScreenManager did not mount");
  }
  mountedRenderers.push(renderer);
  return { renderer, provider, spawnManager };
}

async function flushAsync(ms: number = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function collectText(
  node: TestRenderer.ReactTestRendererJSON | TestRenderer.ReactTestRendererJSON[],
): string {
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join("");
  }
  return (
    node.children
      ?.map((child) => (typeof child === "string" ? child : collectText(child)))
      .join("") ?? ""
  );
}

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  const json = renderer.toJSON();
  if (!json) return "";
  return collectText(json);
}

function expectGoalInput(renderer: TestRenderer.ReactTestRenderer): void {
  expect(renderedText(renderer)).toContain("What should agents work on?");
}

async function pressKey(key: KeyboardKey): Promise<void> {
  const handler = keyboardHandler;
  if (!handler) {
    throw new Error("No keyboard handler registered");
  }
  await act(async () => {
    handler(key);
    await flushAsync();
  });
}

async function typeGoal(goal: string): Promise<void> {
  for (const char of goal) {
    if (char === " ") {
      await pressKey({ name: "space", sequence: " " });
    } else {
      await pressKey({ name: char, sequence: char });
    }
  }
}

async function submitGoal(goal: string): Promise<void> {
  await typeGoal(goal);
  await pressKey({ name: "return" });
}

function requirePresetSelect(): PresetSelectProps {
  const props = captured.presetSelect;
  if (!props) throw new Error("PresetSelect was not rendered");
  return props;
}

function requireLaunchPreview(): AgentDetectProps {
  const props = captured.launchPreview;
  if (!props) throw new Error("Launch preview was not rendered");
  return props;
}

function requireSpawnProgress(): SpawnProgressProps {
  const props = captured.spawnProgress;
  if (!props) throw new Error("SpawnProgress was not rendered");
  return props;
}

function requireRunningView(): RunningViewProps {
  const props = captured.runningView;
  if (!props) throw new Error("RunningView was not rendered");
  return props;
}

function requireCompleteView(): CompleteViewProps {
  const props = captured.completeView;
  if (!props) throw new Error("CompleteView was not rendered");
  return props;
}

describe("ScreenManager transition flow", () => {
  test("preset-select -> goal-input stores the preset and resolves its topology", () => {
    const { renderer } = renderScreenManager({ presets: PRESETS });

    act(() => {
      requirePresetSelect().onSelect("review-loop");
    });

    expectGoalInput(renderer);
    expect(renderedText(renderer)).toContain("2 agents will be configured");
  });

  test("goal-input -> launch-preview preserves the submitted goal", async () => {
    renderScreenManager({ topology: TEST_TOPOLOGY });

    await submitGoal("Implement issue 177");

    expect(captured.screen).toBe("launch-preview");
    expect(requireLaunchPreview().goal).toBe("Implement issue 177");
  });

  test("launch-preview -> spawning creates a session and starts topology roles", async () => {
    const { spawnManager } = renderScreenManager({ topology: TEST_TOPOLOGY });
    await submitGoal("Launch agents");

    await act(async () => {
      requireLaunchPreview().onContinue(
        new Map([
          ["codex", true],
          ["claude", true],
        ]),
        new Map([
          ["planner", "codex"],
          ["builder", "claude"],
        ]),
        new Map([
          ["planner", "Plan carefully"],
          ["builder", "Build carefully"],
        ]),
        new Map([["planner:builder", 120]]),
      );
      await flushAsync();
      await flushAsync();
    });

    expect(captured.screen).toBe("spawning");
    expect(requireSpawnProgress().goal).toBe("Launch agents");
    expect(requireSpawnProgress().agents.map((agent) => agent.role)).toEqual([
      "planner",
      "builder",
    ]);
    expect(spawnManager.sessionGoals).toEqual(["Launch agents"]);
    expect(spawnManager.spawnCalls.map((call) => call.roleId)).toEqual(["planner", "builder"]);
  });

  test("spawning -> running when spawn progress resolves", async () => {
    renderScreenManager({
      topology: TEST_TOPOLOGY,
      initialState: {
        screen: "spawning",
        selectedPreset: "review-loop",
        goal: "Finish spawning",
        spawnStates: [
          { role: "planner", command: "codex", status: "started" },
          { role: "builder", command: "claude", status: "started" },
        ],
      },
    });

    await act(async () => {
      requireSpawnProgress().onAllResolved();
      await flushAsync();
      await flushAsync();
    });

    expect(captured.screen).toBe("running");
  });

  test("running -> complete when the running screen completes", async () => {
    const providerBundle = makeProvider({
      contributions: [makeContribution("c1"), makeContribution("c2")],
    });
    renderScreenManager({
      provider: providerBundle.provider,
      topology: TEST_TOPOLOGY,
      initialState: {
        screen: "running",
        goal: "Complete the session",
        sessionId: "session-done",
        sessionStartedAt: "2026-03-29T00:00:00.000Z",
      },
    });

    await act(async () => {
      requireRunningView().onComplete("All roles signaled done");
      await flushAsync();
      await flushAsync();
    });

    expect(captured.screen).toBe("complete");
    expect(requireCompleteView().reason).toBe("All roles signaled done");
    expect(requireCompleteView().contributionCount).toBe(2);
    expect(providerBundle.calls.archiveSession).toEqual(["session-done"]);
  });

  test("complete -> preset-select starts a fresh session when no preset state is reusable", () => {
    renderScreenManager({
      presets: PRESETS,
      initialState: {
        screen: "complete",
        completeSnapshot: { reason: "Done", contributionCount: 0 },
      },
    });

    act(() => {
      requireCompleteView().onNewSession();
    });

    expect(captured.screen).toBe("preset-select");
  });
});

describe("ScreenManager navigation and edge cases", () => {
  test("goal-input -> preset-select on back when presets exist", async () => {
    renderScreenManager({ presets: PRESETS, topology: TEST_TOPOLOGY });

    await pressKey({ name: "escape" });

    expect(captured.screen).toBe("preset-select");
  });

  test("launch-preview -> goal-input on back", async () => {
    const { renderer } = renderScreenManager({ topology: TEST_TOPOLOGY });
    await submitGoal("Back up from preview");

    act(() => {
      requireLaunchPreview().onBack();
    });

    expectGoalInput(renderer);
  });

  test("empty goal validation keeps Enter on goal-input", async () => {
    const { renderer } = renderScreenManager({ topology: TEST_TOPOLOGY });

    await pressKey({ name: "return" });

    expectGoalInput(renderer);
    expect(renderedText(renderer)).toContain("Goal cannot be empty");
    expect(captured.launchPreview).toBeUndefined();
  });

  test("no topology skips spawning and never attempts to spawn zero agents", async () => {
    const { spawnManager } = renderScreenManager({
      initialState: { screen: "goal-input" },
    });
    await submitGoal("Run without topology");

    await act(async () => {
      requireLaunchPreview().onContinue(new Map(), new Map(), new Map(), new Map());
      await flushAsync();
      await flushAsync();
    });

    expect(captured.screen).toBe("running");
    expect(captured.spawnProgress).toBeUndefined();
    expect(spawnManager.spawnCalls).toEqual([]);
  });

  test("resumed grove starts on running when an active session is available", async () => {
    const providerBundle = makeProvider();
    renderScreenManager({
      provider: providerBundle.provider,
      topology: TEST_TOPOLOGY,
      sessions: [ACTIVE_SESSION],
      startOnRunning: true,
    });

    await act(async () => {
      await flushAsync();
    });

    expect(captured.screen).toBe("running");
    expect(providerBundle.calls.setSessionScope).toEqual(["session-active"]);
  });
});
