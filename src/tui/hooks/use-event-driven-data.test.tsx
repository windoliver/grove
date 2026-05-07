import { describe, expect, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { InformerFactory } from "../../core/informer.js";
import { RefreshProvider, useRelistTrigger } from "./refresh-context.js";
import { useEventDrivenData } from "./use-event-driven-data.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFactory(): InformerFactory {
  return {
    mode: "local",
    supportsKind: () => true,
    startAll: () => undefined,
    stopAll: async () => undefined,
    relist: async () => undefined,
  } as unknown as InformerFactory;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function TriggerProbe(props: { readonly onTrigger: (fn: () => void) => void }): React.ReactNode {
  const trigger = useRelistTrigger();
  props.onTrigger(trigger);
  return null;
}

function DataProbe(props: {
  readonly active: boolean;
  readonly fetcher: () => Promise<string>;
}): React.ReactNode {
  useEventDrivenData(props.fetcher, undefined, undefined, props.active);
  return null;
}

describe("useEventDrivenData", () => {
  test("does not fetch inactive consumers on global refresh", async () => {
    let fetches = 0;
    let trigger: (() => void) | undefined;
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(
          RefreshProvider,
          { factory: makeFactory() },
          React.createElement(DataProbe, {
            active: false,
            fetcher: async () => {
              fetches += 1;
              return "data";
            },
          }),
          React.createElement(TriggerProbe, {
            onTrigger: (fn) => {
              trigger = fn;
            },
          }),
        ),
      );
      await flush();
    });

    expect(fetches).toBe(0);
    await act(async () => {
      trigger?.();
      await flush();
    });

    expect(fetches).toBe(0);
    await act(async () => {
      renderer?.unmount();
    });
  });
});
