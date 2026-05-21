import { describe, expect, mock, test } from "bun:test";
import type { Contribution } from "../../core/models.js";
import type { TuiDataProvider, TuiSessionProvider } from "../provider.js";

type FetchRunningContributions = typeof import("./running-view.js").fetchRunningContributions;
const Fragment = Symbol.for("react.fragment");

function identity<T>(value: T): T {
  return value;
}

function useEffectStub(): void {
  return undefined;
}

function useRefStub<T>(initial: T): { current: T } {
  return { current: initial };
}

function useStateStub<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
  const value = typeof initial === "function" ? (initial as () => T)() : initial;
  return [value, () => undefined];
}

function useReducerStub<S>(
  _reducer: (state: S, action: unknown) => S,
  initial: S,
): [S, (action: unknown) => void] {
  return [initial, () => undefined];
}

function createContextStub<T>(defaultValue: T): { Provider: () => null; _currentValue: T } {
  return {
    Provider: () => null,
    _currentValue: defaultValue,
  };
}

function useContextStub<T>(context: { readonly _currentValue?: T }): T | undefined {
  return context._currentValue;
}

function useSyncExternalStoreStub<T>(
  _subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
): T {
  return getSnapshot();
}

function jsxStub(_type: unknown, _props: unknown, _key?: unknown): null {
  return null;
}

function jsxDevStub(
  _type: unknown,
  _props: unknown,
  _key: unknown,
  _isStaticChildren: unknown,
  _source: unknown,
  _self: unknown,
): null {
  return null;
}

const reactMock = {
  Fragment,
  createContext: createContextStub,
  createElement: jsxStub,
  memo: identity,
  useCallback: identity,
  useContext: useContextStub,
  useEffect: useEffectStub,
  useMemo: identity,
  useReducer: useReducerStub,
  useRef: useRefStub,
  useState: useStateStub,
  useSyncExternalStore: useSyncExternalStoreStub,
};

mock.module("react", () => ({
  default: reactMock,
  ...reactMock,
}));

mock.module("@opentui/react", () => ({
  useKeyboard: (): void => undefined,
  extend: (_components: Record<string, unknown>): void => undefined,
}));

mock.module("@opentui/react/jsx-runtime", () => ({
  jsx: jsxStub,
  jsxs: jsxStub,
  Fragment,
}));

mock.module("@opentui/react/jsx-dev-runtime", () => ({
  jsxDEV: jsxDevStub,
  Fragment,
}));

mock.module("@opentui-ui/dialog/react", () => ({
  useDialog: (): { confirm: () => Promise<boolean> } => ({
    confirm: async () => false,
  }),
}));

mock.module("@opentui-ui/toast/react", () => ({
  toast: {
    error: (): void => undefined,
    success: (): void => undefined,
    warning: (): void => undefined,
    info: (): void => undefined,
    loading: (): string => "stub",
    promise: (): unknown => undefined,
    dismiss: (): void => undefined,
    custom: (): void => undefined,
  },
}));

mock.module("../config-watcher.js", () => ({
  createTuiConfigWatcher: () => ({
    subscribe: () => () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    current: () => ({ aliases: {} }),
  }),
}));

const { fetchRunningContributions }: { fetchRunningContributions: FetchRunningContributions } =
  await import("./running-view.js");

function contribution(cid: string, summary: string): Contribution {
  return {
    cid,
    manifestVersion: 1,
    kind: "work",
    mode: "evaluation",
    summary,
    tags: [],
    artifacts: {},
    relations: [],
    agent: { agentId: "agent-1" },
    createdAt: new Date().toISOString(),
  };
}

function baseCapabilities(sessions: boolean) {
  return {
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
    sessions,
    handoffs: false,
  };
}

describe("fetchRunningContributions", () => {
  test("uses full session contribution history when a session id is present", async () => {
    const sessionHistory = [contribution("blake3:session", "session")];
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(true),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
      getSessionContributions: async (sessionId: string) => {
        calls.push(`getSessionContributions:${sessionId}`);
        return sessionHistory;
      },
    } as unknown as TuiDataProvider & TuiSessionProvider;

    const result = await fetchRunningContributions(provider, "session-1");

    expect(result).toEqual(sessionHistory);
    expect(calls).toEqual(["getSessionContributions:session-1"]);
  });

  test("uses normal contribution list when no session id is present", async () => {
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(true),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
      getSessionContributions: async () => {
        calls.push("getSessionContributions");
        return [];
      },
    } as unknown as TuiDataProvider & TuiSessionProvider;

    const result = await fetchRunningContributions(provider, undefined);

    expect(result).toEqual(liveList);
    expect(calls).toEqual(["getContributions"]);
  });

  test("uses normal contribution list when session id is present but sessions are unsupported", async () => {
    const liveList = [contribution("blake3:live", "live")];
    const calls: string[] = [];
    const provider = {
      capabilities: baseCapabilities(false),
      getContributions: async () => {
        calls.push("getContributions");
        return liveList;
      },
    } as unknown as TuiDataProvider;

    const result = await fetchRunningContributions(provider, "session-1");

    expect(result).toEqual(liveList);
    expect(calls).toEqual(["getContributions"]);
  });
});
