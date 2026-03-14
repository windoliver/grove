/**
 * Tests for usePolledData hook — pure state logic.
 *
 * Tests the pollReducer and computeIsStale functions directly
 * without needing React rendering.
 */

import { describe, expect, test } from "bun:test";
import { computeIsStale, type PollAction, type PollState, pollReducer } from "./use-polled-data.js";

// ---------------------------------------------------------------------------
// pollReducer
// ---------------------------------------------------------------------------

describe("pollReducer", () => {
  const initial: PollState<string> = {
    data: null,
    loading: true,
    error: null,
    lastSuccessAt: null,
  };

  test("success: sets data and clears loading/error", () => {
    const action: PollAction<string> = { type: "success", data: "hello", timestamp: 1000 };
    const next = pollReducer(initial, action);
    expect(next.data).toBe("hello");
    expect(next.loading).toBe(false);
    expect(next.error).toBeNull();
    expect(next.lastSuccessAt).toBe(1000);
  });

  test("error: preserves existing data and sets error", () => {
    const withData: PollState<string> = {
      data: "old-data",
      loading: false,
      error: null,
      lastSuccessAt: 500,
    };
    const err = new Error("fetch failed");
    const action: PollAction<string> = { type: "error", error: err };
    const next = pollReducer(withData, action);
    expect(next.data).toBe("old-data");
    expect(next.loading).toBe(false);
    expect(next.error).toBe(err);
    expect(next.lastSuccessAt).toBe(500); // preserved
  });

  test("error on initial load: data stays null", () => {
    const err = new Error("network error");
    const action: PollAction<string> = { type: "error", error: err };
    const next = pollReducer(initial, action);
    expect(next.data).toBeNull();
    expect(next.loading).toBe(false);
    expect(next.error).toBe(err);
    expect(next.lastSuccessAt).toBeNull();
  });

  test("success after error: clears error, updates data", () => {
    const stale: PollState<string> = {
      data: "old-data",
      loading: false,
      error: new Error("previous error"),
      lastSuccessAt: 100,
    };
    const action: PollAction<string> = { type: "success", data: "new-data", timestamp: 2000 };
    const next = pollReducer(stale, action);
    expect(next.data).toBe("new-data");
    expect(next.error).toBeNull();
    expect(next.lastSuccessAt).toBe(2000);
  });

  test("reset: returns to initial loading state", () => {
    const withData: PollState<string> = {
      data: "some-data",
      loading: false,
      error: null,
      lastSuccessAt: 1000,
    };
    const action: PollAction<string> = { type: "reset" };
    const next = pollReducer(withData, action);
    expect(next.data).toBeNull();
    expect(next.loading).toBe(true);
    expect(next.error).toBeNull();
    expect(next.lastSuccessAt).toBeNull();
  });

  test("multiple successes update data and timestamp", () => {
    let state = initial;
    state = pollReducer(state, { type: "success", data: "first", timestamp: 100 });
    state = pollReducer(state, { type: "success", data: "second", timestamp: 200 });
    expect(state.data).toBe("second");
    expect(state.lastSuccessAt).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// computeIsStale
// ---------------------------------------------------------------------------

describe("computeIsStale", () => {
  test("not stale: no error, has data", () => {
    const state: PollState<string> = {
      data: "fresh",
      loading: false,
      error: null,
      lastSuccessAt: 1000,
    };
    expect(computeIsStale(state)).toBe(false);
  });

  test("not stale: no error, no data (initial load)", () => {
    const state: PollState<string> = {
      data: null,
      loading: true,
      error: null,
      lastSuccessAt: null,
    };
    expect(computeIsStale(state)).toBe(false);
  });

  test("not stale: error but no previous data (never succeeded)", () => {
    const state: PollState<string> = {
      data: null,
      loading: false,
      error: new Error("fail"),
      lastSuccessAt: null,
    };
    expect(computeIsStale(state)).toBe(false);
  });

  test("stale: has error AND has previous data", () => {
    const state: PollState<string> = {
      data: "old-data",
      loading: false,
      error: new Error("fail"),
      lastSuccessAt: 500,
    };
    expect(computeIsStale(state)).toBe(true);
  });
});
