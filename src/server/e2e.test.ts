/**
 * End-to-end tests for grove-server using a real Bun.serve() HTTP server.
 *
 * These tests verify the full request/response cycle over real HTTP,
 * catching issues that app.request() in-memory mode can't detect
 * (e.g., streaming, headers, content negotiation).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DefaultFrontierCalculator } from "../core/frontier.js";
import { InMemoryContributionStore } from "../core/testing.js";
import { createApp } from "./app.js";
import type { ServerDeps } from "./deps.js";
import {
  InMemoryClaimStore,
  InMemoryContentStore,
  makeClaimBody,
  makeManifestBody,
} from "./test-helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: test file — JSON responses are dynamically shaped
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  const contributionStore = new InMemoryContributionStore();
  const claimStore = new InMemoryClaimStore();
  const cas = new InMemoryContentStore();
  const frontier = new DefaultFrontierCalculator(contributionStore);

  const deps: ServerDeps = { contributionStore, claimStore, cas, frontier };
  const app = createApp(deps);

  server = Bun.serve({
    port: 0, // Random available port
    fetch: app.fetch,
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("E2E: health check", () => {
  it("GET /api/health returns ok status", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Json;
    expect(data.status).toBe("ok");
    expect(data.checks.contributionStore).toBe("ok");
    expect(data.checks.claimStore).toBe("ok");
    expect(data.checks.cas).toBe("ok");
    expect(typeof data.uptime).toBe("number");
    expect(typeof data.timestamp).toBe("string");
  });
});

describe("E2E: grove metadata", () => {
  it("GET /api/grove returns metadata", async () => {
    const res = await fetch(`${baseUrl}/api/grove`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Json;
    expect(data.version).toBe("0.1.0");
    expect(data.protocol.manifestVersion).toBe(1);
    expect(typeof data.stats.contributions).toBe("number");
    expect(typeof data.stats.activeClaims).toBe("number");
  });
});

describe("E2E: contribution lifecycle", () => {
  let createdCid: string;

  it("POST /api/contributions creates a contribution", async () => {
    const body = makeManifestBody({ summary: "E2E test contribution" });

    const res = await fetch(`${baseUrl}/api/contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const data = (await res.json()) as Json;
    expect(data.cid).toMatch(/^blake3:[0-9a-f]{64}$/);
    createdCid = data.cid;
  });

  it("GET /api/contributions lists contributions", async () => {
    const res = await fetch(`${baseUrl}/api/contributions`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBeTruthy();
    const data = (await res.json()) as Json;
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/contributions/:cid returns a single contribution", async () => {
    const res = await fetch(`${baseUrl}/api/contributions/${createdCid}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Json;
    expect(data.cid).toBe(createdCid);
    expect(data.summary).toBe("E2E test contribution");
  });

  it("GET /api/contributions/:cid returns 404 for non-existent", async () => {
    const fakeCid = `blake3:${"f".repeat(64)}`;
    const res = await fetch(`${baseUrl}/api/contributions/${fakeCid}`);
    expect(res.status).toBe(404);
  });
});

describe("E2E: multipart upload and artifact download", () => {
  it("uploads artifact via multipart and downloads it", async () => {
    const manifest = makeManifestBody({ summary: "with artifact" });
    const artifactContent = "Hello from E2E test";

    const formData = new FormData();
    formData.append("manifest", JSON.stringify(manifest));
    formData.append(
      "artifact:notes.txt",
      new File([artifactContent], "notes.txt", { type: "text/plain" }),
    );

    const createRes = await fetch(`${baseUrl}/api/contributions`, {
      method: "POST",
      body: formData,
    });

    expect(createRes.status).toBe(201);
    const contribution = (await createRes.json()) as Json;
    expect(contribution.artifacts["notes.txt"]).toMatch(/^blake3:/);

    // Download the artifact
    const downloadRes = await fetch(
      `${baseUrl}/api/contributions/${contribution.cid}/artifacts/notes.txt`,
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Content-Type")).toContain("text/plain");
    const body = await downloadRes.text();
    expect(body).toBe(artifactContent);
  });
});

describe("E2E: claim lifecycle", () => {
  it("creates, heartbeats, and completes a claim", async () => {
    const body = makeClaimBody({ targetRef: "e2e-target" });

    // Create
    const createRes = await fetch(`${baseUrl}/api/claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(createRes.status).toBe(201);
    const claim = (await createRes.json()) as Json;
    expect(claim.status).toBe("active");

    // Heartbeat
    const hbRes = await fetch(`${baseUrl}/api/claims/${claim.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "heartbeat" }),
    });
    expect(hbRes.status).toBe(200);

    // Complete
    const completeRes = await fetch(`${baseUrl}/api/claims/${claim.claimId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete" }),
    });
    expect(completeRes.status).toBe(200);
    const completed = (await completeRes.json()) as Json;
    expect(completed.status).toBe("completed");
  });

  it("GET /api/claims lists claims", async () => {
    const res = await fetch(`${baseUrl}/api/claims`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Json;
    expect(Array.isArray(data.claims)).toBe(true);
    expect(typeof data.count).toBe("number");
  });
});

describe("E2E: frontier", () => {
  it("GET /api/frontier returns frontier data", async () => {
    const res = await fetch(`${baseUrl}/api/frontier`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Json;
    expect(data).toHaveProperty("byMetric");
    expect(data).toHaveProperty("byAdoption");
    expect(data).toHaveProperty("byRecency");
  });
});

describe("E2E: search", () => {
  it("GET /api/search?q=... returns search results", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=E2E`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Json;
    expect(Array.isArray(data.results)).toBe(true);
    expect(typeof data.count).toBe("number");
  });

  it("GET /api/search without q returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/search`);
    expect(res.status).toBe(400);
  });
});

describe("E2E: DAG traversal", () => {
  it("returns children and ancestors", async () => {
    // Create parent
    const parentBody = makeManifestBody({ summary: "e2e parent" });
    const parentRes = await fetch(`${baseUrl}/api/contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parentBody),
    });
    const parent = (await parentRes.json()) as Json;

    // Create child referencing parent
    const childBody = makeManifestBody({
      summary: "e2e child",
      relations: [{ targetCid: parent.cid, relationType: "derives_from" }],
    });
    const childRes = await fetch(`${baseUrl}/api/contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(childBody),
    });
    const child = (await childRes.json()) as Json;

    // Children of parent
    const childrenRes = await fetch(`${baseUrl}/api/dag/${parent.cid}/children`);
    expect(childrenRes.status).toBe(200);
    const children = (await childrenRes.json()) as Json;
    expect(children).toHaveLength(1);
    expect(children[0].cid).toBe(child.cid);

    // Ancestors of child
    const ancestorsRes = await fetch(`${baseUrl}/api/dag/${child.cid}/ancestors`);
    expect(ancestorsRes.status).toBe(200);
    const ancestors = (await ancestorsRes.json()) as Json;
    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].cid).toBe(parent.cid);
  });
});

describe("E2E: validation errors", () => {
  it("returns 400 for invalid contribution body", async () => {
    const res = await fetch(`${baseUrl}/api/contributions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid CID format in path", async () => {
    const res = await fetch(`${baseUrl}/api/contributions/not-a-cid`);
    expect(res.status).toBe(400);
  });
});
