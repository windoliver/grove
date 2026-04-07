/**
 * Tests for mapPollResult — the pure state-mapping function from
 * PolledDataResult to a PanelState discriminated union.
 *
 * Tests the hook logic directly without a React renderer, following
 * the same pattern as use-polled-data.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { mapPollResult } from "./use-panel-state.js";

describe("mapPollResult", () => {
  // -------------------------------------------------------------------------
  // loading state
  // -------------------------------------------------------------------------

  test("loading: initial fetch in progress → status=loading", () => {
    const state = mapPollResult({ data: null, loading: true, error: null, isStale: false });
    expect(state.status).toBe("loading");
  });

  // -------------------------------------------------------------------------
  // error state
  // -------------------------------------------------------------------------

  test("error: initial fetch failed, no prior data → status=error", () => {
    const err = new Error("network error");
    const state = mapPollResult({ data: null, loading: false, error: err, isStale: false });
    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.error).toBe(err);
    }
  });

  test("error: error message is preserved", () => {
    const err = new Error("401 Unauthorized");
    const state = mapPollResult({ data: null, loading: false, error: err, isStale: false });
    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.error.message).toBe("401 Unauthorized");
    }
  });

  // -------------------------------------------------------------------------
  // ready state — fresh data
  // -------------------------------------------------------------------------

  test("ready: fresh data, no error → status=ready, isStale=false", () => {
    const state = mapPollResult({ data: "hello", loading: false, error: null, isStale: false });
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.data).toBe("hello");
      expect(state.isStale).toBe(false);
      expect(state.error).toBeNull();
    }
  });

  test("ready: data is an array (common provider case)", () => {
    const arr = [1, 2, 3];
    const state = mapPollResult<number[]>({ data: arr, loading: false, error: null, isStale: false });
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.data).toEqual([1, 2, 3]);
    }
  });

  test("ready: data is an empty array — not an error, caller decides emptiness", () => {
    const state = mapPollResult<string[]>({ data: [], loading: false, error: null, isStale: false });
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.data).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // ready+stale state — has data but last re-fetch errored
  // -------------------------------------------------------------------------

  test("stale: last re-fetch errored, prior data preserved → status=ready, isStale=true", () => {
    const err = new Error("timeout");
    const state = mapPollResult<string>({
      data: "old-data",
      loading: false,
      error: err,
      isStale: true,
    });
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.data).toBe("old-data");
      expect(state.isStale).toBe(true);
      expect(state.error).toBe(err);
    }
  });

  test("stale: error is accessible in ready state for DataStatus display", () => {
    const err = new Error("503 Service Unavailable");
    const state = mapPollResult({ data: { count: 5 }, loading: false, error: err, isStale: true });
    expect(state.status).toBe("ready");
    if (state.status === "ready") {
      expect(state.error?.message).toBe("503 Service Unavailable");
    }
  });

  // -------------------------------------------------------------------------
  // Sequence tests — simulate realistic poll transitions
  // -------------------------------------------------------------------------

  test("sequence: loading → error → (stays error with no data)", () => {
    const err = new Error("connection refused");
    const initialState = mapPollResult({ data: null, loading: true, error: null, isStale: false });
    expect(initialState.status).toBe("loading");

    const errorState = mapPollResult({ data: null, loading: false, error: err, isStale: false });
    expect(errorState.status).toBe("error");
  });

  test("sequence: loading → ready → stale (data preserved on re-fetch error)", () => {
    const loadingState = mapPollResult({
      data: null,
      loading: true,
      error: null,
      isStale: false,
    });
    expect(loadingState.status).toBe("loading");

    const readyState = mapPollResult({
      data: "fresh",
      loading: false,
      error: null,
      isStale: false,
    });
    expect(readyState.status).toBe("ready");

    const staleState = mapPollResult({
      data: "fresh",
      loading: false,
      error: new Error("poll failed"),
      isStale: true,
    });
    expect(staleState.status).toBe("ready");
    if (staleState.status === "ready") {
      expect(staleState.data).toBe("fresh");
      expect(staleState.isStale).toBe(true);
    }
  });
});
