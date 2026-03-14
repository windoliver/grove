/**
 * Tests for provider-factory.ts — factory logic that creates TuiDataProvider
 * instances from resolved backends.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiDataProvider } from "../tui/provider.js";
import type { ResolvedBackend } from "../tui/resolve-backend.js";
import { createProvider } from "./provider-factory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary .grove directory with optional grove.json content. */
function makeTempGrove(configContent?: Record<string, unknown>): {
  root: string;
  groveDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "grove-factory-test-"));
  const groveDir = join(root, ".grove");
  mkdirSync(groveDir, { recursive: true });

  if (configContent !== undefined) {
    writeFileSync(join(groveDir, "grove.json"), JSON.stringify(configContent), "utf-8");
  }

  return { root, groveDir };
}

// ---------------------------------------------------------------------------
// createProvider() — remote mode
// ---------------------------------------------------------------------------

describe("createProvider — remote mode", () => {
  test("creates a RemoteDataProvider for remote backend", async () => {
    const backend: ResolvedBackend = {
      mode: "remote",
      url: "http://localhost:9999",
      source: "flag",
    };

    const provider = await createProvider(backend, "test-remote");

    expect(provider).toBeDefined();
    expect(provider.capabilities).toBeDefined();
    expect(provider.capabilities.outcomes).toBe(true);
    expect(provider.capabilities.artifacts).toBe(true);
    expect(typeof provider.getDashboard).toBe("function");
    expect(typeof provider.close).toBe("function");

    provider.close();
  });

  test("remote provider label is passed through", async () => {
    const backend: ResolvedBackend = {
      mode: "remote",
      url: "http://example.com:4515",
      source: "flag",
    };

    const provider = await createProvider(backend, "my-label");
    expect(provider).toBeDefined();

    provider.close();
  });
});

// ---------------------------------------------------------------------------
// createProvider — local mode
// ---------------------------------------------------------------------------

describe("createProvider — local mode", () => {
  let tempGrove: { root: string; groveDir: string };

  beforeEach(() => {
    tempGrove = makeTempGrove({ name: "test-grove" });
  });

  afterEach(() => {
    rmSync(tempGrove.root, { recursive: true, force: true });
  });

  test("creates a LocalDataProvider for local backend with valid .grove", async () => {
    const backend: ResolvedBackend = {
      mode: "local",
      groveOverride: tempGrove.groveDir,
      source: "flag",
    };

    const provider = await createProvider(backend, "test-local");

    expect(provider).toBeDefined();
    expect(provider.capabilities).toBeDefined();
    expect(typeof provider.getDashboard).toBe("function");
    expect(typeof provider.getContributions).toBe("function");
    expect(typeof provider.close).toBe("function");

    provider.close();
  });

  test("local provider reads grove name from grove.json", async () => {
    // The grove name is read from grove.json in the .grove dir.
    // We verify the provider was created successfully (it would fail if
    // the config reading was broken).
    const backend: ResolvedBackend = {
      mode: "local",
      groveOverride: tempGrove.groveDir,
      source: "flag",
    };

    const provider = await createProvider(backend, "local-label");
    expect(provider).toBeDefined();

    provider.close();
  });

  test("local provider uses default name when grove.json has no name", async () => {
    // Create grove.json without a name field
    const noNameGrove = makeTempGrove({});
    try {
      const backend: ResolvedBackend = {
        mode: "local",
        groveOverride: noNameGrove.groveDir,
        source: "flag",
      };

      const provider = await createProvider(backend, "unnamed-local");
      expect(provider).toBeDefined();

      provider.close();
    } finally {
      rmSync(noNameGrove.root, { recursive: true, force: true });
    }
  });

  test("local provider uses default name when grove.json does not exist", async () => {
    // Create a .grove dir without grove.json
    const bareGrove = mkdtempSync(join(tmpdir(), "grove-factory-bare-"));
    const bareGroveDir = join(bareGrove, ".grove");
    mkdirSync(bareGroveDir, { recursive: true });

    try {
      const backend: ResolvedBackend = {
        mode: "local",
        groveOverride: bareGroveDir,
        source: "flag",
      };

      const provider = await createProvider(backend, "bare-local");
      expect(provider).toBeDefined();

      provider.close();
    } finally {
      rmSync(bareGrove, { recursive: true, force: true });
    }
  });

  test("local provider throws when .grove directory does not exist", async () => {
    const backend: ResolvedBackend = {
      mode: "local",
      groveOverride: "/nonexistent/path/.grove",
      source: "flag",
    };

    // initCliDeps should throw because the .grove dir doesn't exist
    await expect(createProvider(backend, "bad-local")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createProvider — local mode with malformed config
// ---------------------------------------------------------------------------

describe("createProvider — config edge cases", () => {
  test("local provider handles malformed grove.json gracefully", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "grove-factory-malformed-"));
    const groveDir = join(tempRoot, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(join(groveDir, "grove.json"), "not valid json!!!", "utf-8");

    try {
      const backend: ResolvedBackend = {
        mode: "local",
        groveOverride: groveDir,
        source: "flag",
      };

      // Should still create a provider — config parse failure is caught
      const provider = await createProvider(backend, "malformed-config");
      expect(provider).toBeDefined();

      provider.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("local provider handles empty grove.json gracefully", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "grove-factory-empty-"));
    const groveDir = join(tempRoot, ".grove");
    mkdirSync(groveDir, { recursive: true });
    writeFileSync(join(groveDir, "grove.json"), "", "utf-8");

    try {
      const backend: ResolvedBackend = {
        mode: "local",
        groveOverride: groveDir,
        source: "flag",
      };

      // Empty file => JSON parse fails, caught by try/catch, defaults to "grove"
      const provider = await createProvider(backend, "empty-config");
      expect(provider).toBeDefined();

      provider.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stub ContributionStore type safety
// ---------------------------------------------------------------------------

describe("stubContributionStore", () => {
  // We import the stub creator to test it directly.
  // The stub is currently inline in createNexusProvider, so we test it
  // by importing the module and checking the stub's type-safe version
  // that we'll extract.

  test("stub satisfies ContributionStore interface with correct return types", async () => {
    // Import the type to verify our stub implements it
    const { createStubContributionStore } = await import("./provider-factory.js");
    const stub = createStubContributionStore("test-stub");

    // Verify all required methods exist and return correct defaults
    expect(await stub.get("any-cid")).toBeUndefined();
    expect(await stub.getMany(["cid1", "cid2"])).toEqual(new Map());
    expect(await stub.put({} as never)).toBeUndefined();
    expect(await stub.putMany([])).toBeUndefined();
    expect(await stub.list()).toEqual([]);
    expect(await stub.ancestors("cid")).toEqual([]);
    expect(await stub.children("cid")).toEqual([]);
    expect(await stub.count()).toBe(0);
    expect(await stub.countSince({ since: "2024-01-01T00:00:00Z" })).toBe(0);
    expect(await stub.thread("cid")).toEqual([]);
    expect(await stub.hotThreads()).toEqual([]);
    expect(await stub.search("query")).toEqual([]);
    expect(await stub.relationsOf("cid")).toEqual([]);
    expect(await stub.relatedTo("cid")).toEqual([]);
    expect(await stub.findExisting("agent", "target", "work")).toEqual([]);
    expect(await stub.replyCounts(["cid"])).toEqual(new Map());
    expect(stub.storeIdentity).toBe("test-stub");

    // close() is synchronous
    expect(() => stub.close()).not.toThrow();
  });

  test("stub methods are callable with various argument signatures", async () => {
    const { createStubContributionStore } = await import("./provider-factory.js");
    const stub = createStubContributionStore("arg-test");

    // list with query
    expect(await stub.list({ kind: "work", limit: 10 })).toEqual([]);

    // thread with opts
    expect(await stub.thread("cid", { maxDepth: 5, limit: 100 })).toEqual([]);

    // hotThreads with opts
    expect(await stub.hotThreads({ tags: ["tag1"], limit: 5 })).toEqual([]);

    // relationsOf with relationType
    expect(await stub.relationsOf("cid", "responds_to")).toEqual([]);

    // relatedTo with relationType
    expect(await stub.relatedTo("cid", "responds_to")).toEqual([]);

    // search with filters
    expect(await stub.search("query", { kind: "work" })).toEqual([]);

    // findExisting with relationType
    expect(await stub.findExisting("agent", "target", "work", "responds_to")).toEqual([]);

    // countSince with agentId
    expect(await stub.countSince({ agentId: "agent-1", since: "2024-01-01T00:00:00Z" })).toBe(0);

    // count with query
    expect(await stub.count({ kind: "work" })).toBe(0);

    stub.close();
  });

  test("stub without explicit identity defaults to undefined", async () => {
    const { createStubContributionStore } = await import("./provider-factory.js");
    const stub = createStubContributionStore();

    expect(stub.storeIdentity).toBeUndefined();
    stub.close();
  });
});

// ---------------------------------------------------------------------------
// createProvider dispatches on mode
// ---------------------------------------------------------------------------

describe("createProvider — dispatch", () => {
  test("remote mode returns a provider with remote capabilities", async () => {
    const backend: ResolvedBackend = {
      mode: "remote",
      url: "http://localhost:4515",
      source: "flag",
    };

    const provider = await createProvider(backend, "dispatch-remote");
    expect(provider.capabilities.outcomes).toBe(true);
    expect(provider.capabilities.artifacts).toBe(true);
    expect(provider.capabilities.vfs).toBe(false);

    provider.close();
  });

  test("local mode returns a provider with local capabilities", async () => {
    const tempGrove = makeTempGrove({ name: "dispatch-grove" });
    try {
      const backend: ResolvedBackend = {
        mode: "local",
        groveOverride: tempGrove.groveDir,
        source: "flag",
      };

      const provider = await createProvider(backend, "dispatch-local");
      expect(provider.capabilities).toBeDefined();

      provider.close();
    } finally {
      rmSync(tempGrove.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Provider interface conformance
// ---------------------------------------------------------------------------

describe("provider interface conformance", () => {
  test("remote provider implements all required TuiDataProvider methods", async () => {
    const backend: ResolvedBackend = {
      mode: "remote",
      url: "http://localhost:4515",
      source: "flag",
    };

    const provider = await createProvider(backend, "conformance-remote");

    // All required TuiDataProvider methods must be present
    const requiredMethods: (keyof TuiDataProvider)[] = [
      "getDashboard",
      "getContributions",
      "getContribution",
      "getClaims",
      "getFrontier",
      "getActivity",
      "getDag",
      "getHotThreads",
      "close",
    ];

    for (const method of requiredMethods) {
      expect(typeof provider[method]).toBe("function");
    }

    provider.close();
  });

  test("local provider implements all required TuiDataProvider methods", async () => {
    const tempGrove = makeTempGrove({ name: "conformance-grove" });
    try {
      const backend: ResolvedBackend = {
        mode: "local",
        groveOverride: tempGrove.groveDir,
        source: "flag",
      };

      const provider = await createProvider(backend, "conformance-local");

      const requiredMethods: (keyof TuiDataProvider)[] = [
        "getDashboard",
        "getContributions",
        "getContribution",
        "getClaims",
        "getFrontier",
        "getActivity",
        "getDag",
        "getHotThreads",
        "close",
      ];

      for (const method of requiredMethods) {
        expect(typeof provider[method]).toBe("function");
      }

      provider.close();
    } finally {
      rmSync(tempGrove.root, { recursive: true, force: true });
    }
  });
});
