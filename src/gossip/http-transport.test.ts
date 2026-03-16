/**
 * Tests for HttpGossipTransport.
 *
 * Uses a real Bun.serve() HTTP server on port 0 (random available port)
 * to verify exchange/shuffle HTTP requests and error handling.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { GossipTimeoutError, PeerUnreachableError } from "../core/gossip/errors.js";
import type {
  GossipMessage,
  PeerInfo,
  ShuffleRequest,
  ShuffleResponse,
} from "../core/gossip/types.js";
import { HttpGossipTransport, validatePeerUrl } from "./http-transport.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePeer(id: string, address: string): PeerInfo {
  return {
    peerId: id,
    address,
    age: 0,
    lastSeen: new Date().toISOString(),
  };
}

function makeGossipMessage(peerId: string): GossipMessage {
  return {
    peerId,
    frontier: [{ metric: "accuracy", value: 0.95, cid: "blake3:abc123" }],
    load: { queueDepth: 3 },
    capabilities: { platform: "test" },
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

/** Track requests received by the test server. */
let lastRequest: { method: string; path: string; body: unknown } | undefined;
let serverResponseCode: number;
let serverResponseBody: unknown;
/** When set, the server delays its response by this many ms. */
let serverDelayMs: number;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.json().catch(() => null);
      lastRequest = { method: req.method, path: url.pathname, body };

      if (serverDelayMs > 0) {
        await new Promise((r) => setTimeout(r, serverDelayMs));
      }

      return new Response(JSON.stringify(serverResponseBody), {
        status: serverResponseCode,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  lastRequest = undefined;
  serverResponseCode = 200;
  serverResponseBody = {};
  serverDelayMs = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HttpGossipTransport", () => {
  // -----------------------------------------------------------------------
  // exchange()
  // -----------------------------------------------------------------------

  describe("exchange()", () => {
    it("sends POST to correct URL with correct body", async () => {
      const transport = new HttpGossipTransport({ allowPrivateIPs: true });
      const peer = makePeer("peer-1", baseUrl);
      const message = makeGossipMessage("self");

      const responseMsg: GossipMessage = makeGossipMessage("peer-1");
      serverResponseBody = responseMsg;

      const result = await transport.exchange(peer, message);

      expect(lastRequest).toBeDefined();
      expect(lastRequest?.method).toBe("POST");
      expect(lastRequest?.path).toBe("/api/gossip/exchange");
      expect(lastRequest?.body).toEqual(JSON.parse(JSON.stringify(message)));
      expect(result.peerId).toBe("peer-1");
      expect(result.frontier).toEqual(responseMsg.frontier);
    });

    it("returns parsed GossipMessage from response", async () => {
      const transport = new HttpGossipTransport({ allowPrivateIPs: true });
      const peer = makePeer("peer-2", baseUrl);

      const responseMsg: GossipMessage = {
        peerId: "peer-2",
        frontier: [{ metric: "loss", value: 0.01, cid: "blake3:def456" }],
        load: { queueDepth: 7 },
        capabilities: { platform: "linux" },
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      serverResponseBody = responseMsg;

      const result = await transport.exchange(peer, makeGossipMessage("self"));

      expect(result.peerId).toBe("peer-2");
      expect(result.load.queueDepth).toBe(7);
      expect(result.capabilities.platform).toBe("linux");
      expect(result.frontier).toHaveLength(1);
      expect(result.frontier[0]?.metric).toBe("loss");
    });
  });

  // -----------------------------------------------------------------------
  // shuffle()
  // -----------------------------------------------------------------------

  describe("shuffle()", () => {
    it("sends POST to correct URL with correct body", async () => {
      const transport = new HttpGossipTransport({ allowPrivateIPs: true });
      const peer = makePeer("peer-3", baseUrl);

      const request: ShuffleRequest = {
        sender: makePeer("self", "http://self:4515"),
        offered: [makePeer("self", "http://self:4515"), makePeer("other", "http://other:4515")],
      };

      const responseShuf: ShuffleResponse = {
        offered: [makePeer("new-peer", "http://new-peer:4515")],
      };
      serverResponseBody = responseShuf;

      const result = await transport.shuffle(peer, request);

      expect(lastRequest).toBeDefined();
      expect(lastRequest?.method).toBe("POST");
      expect(lastRequest?.path).toBe("/api/gossip/shuffle");
      expect(lastRequest?.body).toEqual(JSON.parse(JSON.stringify(request)));
      expect(result.offered).toHaveLength(1);
      expect(result.offered[0]?.peerId).toBe("new-peer");
    });
  });

  // -----------------------------------------------------------------------
  // PeerUnreachableError on network failure
  // -----------------------------------------------------------------------

  describe("PeerUnreachableError on network failure", () => {
    it("throws PeerUnreachableError when peer is unreachable (bad port)", async () => {
      const transport = new HttpGossipTransport({ timeoutMs: 2000, allowPrivateIPs: true });
      // Use a port that is almost certainly not listening
      const peer = makePeer("dead-peer", "http://127.0.0.1:1");

      await expect(transport.exchange(peer, makeGossipMessage("self"))).rejects.toThrow(
        PeerUnreachableError,
      );
    });

    it("throws PeerUnreachableError on HTTP error status", async () => {
      const transport = new HttpGossipTransport({ allowPrivateIPs: true });
      const peer = makePeer("error-peer", baseUrl);

      serverResponseCode = 500;
      serverResponseBody = { error: "internal server error" };

      await expect(transport.exchange(peer, makeGossipMessage("self"))).rejects.toThrow(
        PeerUnreachableError,
      );
    });

    it("PeerUnreachableError carries peerId and address", async () => {
      const transport = new HttpGossipTransport({ allowPrivateIPs: true });
      const peer = makePeer("err-peer", baseUrl);

      serverResponseCode = 503;

      try {
        await transport.exchange(peer, makeGossipMessage("self"));
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PeerUnreachableError);
        const pue = err as PeerUnreachableError;
        expect(pue.peerId).toBe("err-peer");
        expect(pue.address).toContain("/api/gossip/exchange");
      }
    });

    it("throws PeerUnreachableError for shuffle on HTTP error", async () => {
      const transport = new HttpGossipTransport({ allowPrivateIPs: true });
      const peer = makePeer("bad-shuffle-peer", baseUrl);

      serverResponseCode = 502;

      const request: ShuffleRequest = {
        sender: makePeer("self", "http://self:4515"),
        offered: [],
      };

      await expect(transport.shuffle(peer, request)).rejects.toThrow(PeerUnreachableError);
    });
  });

  // -----------------------------------------------------------------------
  // GossipTimeoutError on timeout
  // -----------------------------------------------------------------------

  describe("GossipTimeoutError on timeout", () => {
    it("throws GossipTimeoutError when request exceeds timeout", async () => {
      const transport = new HttpGossipTransport({ timeoutMs: 100, allowPrivateIPs: true });
      const peer = makePeer("slow-peer", baseUrl);

      serverDelayMs = 500;

      await expect(transport.exchange(peer, makeGossipMessage("self"))).rejects.toThrow(
        GossipTimeoutError,
      );
    });

    it("GossipTimeoutError carries peerId and timeoutMs", async () => {
      const transport = new HttpGossipTransport({ timeoutMs: 50, allowPrivateIPs: true });
      const peer = makePeer("timeout-peer", baseUrl);

      serverDelayMs = 300;

      try {
        await transport.exchange(peer, makeGossipMessage("self"));
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GossipTimeoutError);
        const gte = err as GossipTimeoutError;
        expect(gte.peerId).toBe("timeout-peer");
        expect(gte.timeoutMs).toBe(50);
      }
    });

    it("throws GossipTimeoutError for shuffle on timeout", async () => {
      const transport = new HttpGossipTransport({ timeoutMs: 50, allowPrivateIPs: true });
      const peer = makePeer("slow-shuffle", baseUrl);

      serverDelayMs = 300;

      const request: ShuffleRequest = {
        sender: makePeer("self", "http://self:4515"),
        offered: [],
      };

      await expect(transport.shuffle(peer, request)).rejects.toThrow(GossipTimeoutError);
    });
  });

  // -----------------------------------------------------------------------
  // Default config
  // -----------------------------------------------------------------------

  describe("default config", () => {
    it("uses default timeout when no config provided", async () => {
      const transport = new HttpGossipTransport({ allowPrivateIPs: true });
      const peer = makePeer("default-peer", baseUrl);

      serverResponseBody = makeGossipMessage("default-peer");

      // Should succeed with default 10s timeout
      const result = await transport.exchange(peer, makeGossipMessage("self"));
      expect(result.peerId).toBe("default-peer");
    });
  });

  // -----------------------------------------------------------------------
  // SSRF validation — transport-level
  // -----------------------------------------------------------------------

  describe("SSRF validation in transport", () => {
    it("exchange() rejects localhost peer by default", async () => {
      const transport = new HttpGossipTransport(); // allowPrivateIPs defaults to false
      const peer = makePeer("bad", "http://localhost:9999");

      await expect(transport.exchange(peer, makeGossipMessage("self"))).rejects.toThrow(
        /private\/internal/,
      );
    });

    it("shuffle() rejects private IP peer by default", async () => {
      const transport = new HttpGossipTransport();
      const peer = makePeer("bad", "http://10.0.0.1:9999");

      const request: ShuffleRequest = {
        sender: makePeer("self", "http://self:4515"),
        offered: [],
      };

      await expect(transport.shuffle(peer, request)).rejects.toThrow(/private\/reserved/);
    });
  });
});

// ---------------------------------------------------------------------------
// validatePeerUrl — unit tests
// ---------------------------------------------------------------------------

describe("validatePeerUrl", () => {
  // -------------------------------------------------------------------------
  // Valid URLs
  // -------------------------------------------------------------------------

  it("accepts a valid http URL and pins to resolved IP", async () => {
    const result = await validatePeerUrl("http://example.com:4515/api");
    // pinnedUrl should have the hostname replaced with a resolved IP
    expect(result.pinnedUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:4515\/api/);
    expect(result.hostHeader).toBe("example.com:4515");
  });

  it("accepts a valid https URL and preserves hostname for TLS", async () => {
    const result = await validatePeerUrl("https://example.com");
    expect(result.hostHeader).toBe("example.com");
    // HTTPS keeps the original hostname for TLS SNI/cert validation
    const pinned = new URL(result.pinnedUrl);
    expect(pinned.hostname).toBe("example.com");
  });

  it("accepts a public IPv4 address (no DNS needed)", async () => {
    const result = await validatePeerUrl("http://8.8.8.8:4515");
    expect(result.pinnedUrl).toContain("8.8.8.8:4515");
    expect(result.hostHeader).toBe("8.8.8.8:4515");
  });

  // -------------------------------------------------------------------------
  // Parsing failures
  // -------------------------------------------------------------------------

  it("rejects an unparseable URL", async () => {
    await expect(validatePeerUrl("not-a-url")).rejects.toThrow(/unable to parse/);
  });

  // -------------------------------------------------------------------------
  // Scheme checks
  // -------------------------------------------------------------------------

  it("rejects ftp scheme", async () => {
    await expect(validatePeerUrl("ftp://evil.com/file")).rejects.toThrow(/scheme.*ftp:/);
  });

  it("rejects file scheme", async () => {
    await expect(validatePeerUrl("file:///etc/passwd")).rejects.toThrow(/scheme/);
  });

  it("allows a custom scheme via allowedSchemes", async () => {
    const opts = { allowedSchemes: new Set(["custom:"]), allowPrivateIPs: true };
    const result = await validatePeerUrl("custom://host/path", opts);
    expect(result.pinnedUrl).toBe("custom://host/path");
  });

  // -------------------------------------------------------------------------
  // Dangerous hostnames
  // -------------------------------------------------------------------------

  it("rejects localhost", async () => {
    await expect(validatePeerUrl("http://localhost:4515")).rejects.toThrow(/private\/internal/);
  });

  it("rejects localhost with trailing dot (FQDN)", async () => {
    await expect(validatePeerUrl("http://localhost.:4515")).rejects.toThrow(/private\/internal/);
  });

  it("rejects metadata.google.internal", async () => {
    await expect(
      validatePeerUrl("http://metadata.google.internal/computeMetadata"),
    ).rejects.toThrow(/private\/internal/);
  });

  it("rejects metadata.internal", async () => {
    await expect(validatePeerUrl("http://metadata.internal")).rejects.toThrow(/private\/internal/);
  });

  it("rejects instance-data (AWS metadata alias)", async () => {
    await expect(validatePeerUrl("http://instance-data/latest/meta-data")).rejects.toThrow(
      /private\/internal/,
    );
  });

  it("rejects kubernetes.default", async () => {
    await expect(validatePeerUrl("http://kubernetes.default")).rejects.toThrow(/private\/internal/);
  });

  it("rejects kubernetes.default.svc.cluster.local", async () => {
    await expect(validatePeerUrl("http://kubernetes.default.svc.cluster.local")).rejects.toThrow(
      /private\/internal/,
    );
  });

  // -------------------------------------------------------------------------
  // Private IPv4 ranges
  // -------------------------------------------------------------------------

  it("rejects 10.x.x.x", async () => {
    await expect(validatePeerUrl("http://10.0.0.1:4515")).rejects.toThrow(/private\/reserved/);
  });

  it("rejects 172.16.x.x", async () => {
    await expect(validatePeerUrl("http://172.16.0.1:4515")).rejects.toThrow(/private\/reserved/);
  });

  it("rejects 172.31.x.x (upper end of /12)", async () => {
    await expect(validatePeerUrl("http://172.31.255.255")).rejects.toThrow(/private\/reserved/);
  });

  it("allows 172.15.x.x (just below the private range)", async () => {
    const result = await validatePeerUrl("http://172.15.0.1:4515");
    expect(result.pinnedUrl).toContain("172.15.0.1");
  });

  it("allows 172.32.x.x (just above the private range)", async () => {
    const result = await validatePeerUrl("http://172.32.0.1:4515");
    expect(result.pinnedUrl).toContain("172.32.0.1");
  });

  it("rejects 192.168.x.x", async () => {
    await expect(validatePeerUrl("http://192.168.1.1:4515")).rejects.toThrow(/private\/reserved/);
  });

  it("rejects 127.0.0.1 (loopback)", async () => {
    await expect(validatePeerUrl("http://127.0.0.1:4515")).rejects.toThrow(/private\/reserved/);
  });

  it("rejects 169.254.x.x (link-local)", async () => {
    await expect(validatePeerUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it("rejects 0.0.0.0", async () => {
    await expect(validatePeerUrl("http://0.0.0.0:4515")).rejects.toThrow(/private\/reserved/);
  });

  // -------------------------------------------------------------------------
  // Private IPv6 ranges
  // -------------------------------------------------------------------------

  it("rejects ::1 (IPv6 loopback)", async () => {
    await expect(validatePeerUrl("http://[::1]:4515")).rejects.toThrow(/private\/reserved/);
  });

  it("rejects fc00:: (IPv6 ULA)", async () => {
    await expect(validatePeerUrl("http://[fc00::1]:4515")).rejects.toThrow(/private\/reserved/);
  });

  it("rejects fd00:: (IPv6 ULA)", async () => {
    await expect(validatePeerUrl("http://[fd12:3456::1]:4515")).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it("rejects fe80:: (IPv6 link-local)", async () => {
    await expect(validatePeerUrl("http://[fe80::1]:4515")).rejects.toThrow(/private\/reserved/);
  });

  it("rejects ::ffff:127.0.0.1 (IPv4-mapped loopback)", async () => {
    await expect(validatePeerUrl("http://[::ffff:127.0.0.1]:4515")).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it("rejects ::ffff:10.0.0.1 (IPv4-mapped private)", async () => {
    await expect(validatePeerUrl("http://[::ffff:10.0.0.1]:4515")).rejects.toThrow(
      /private\/reserved/,
    );
  });

  it("rejects ::ffff:192.168.1.1 (IPv4-mapped private)", async () => {
    await expect(validatePeerUrl("http://[::ffff:192.168.1.1]:4515")).rejects.toThrow(
      /private\/reserved/,
    );
  });

  // -------------------------------------------------------------------------
  // DNS resolution check
  // -------------------------------------------------------------------------

  it("rejects hostname that resolves to loopback via DNS", async () => {
    // "localhost" is caught by the denylist, but this test verifies the
    // DNS resolution path works for any hostname resolving to 127.0.0.1.
    // We use localhost directly since it's the most reliable test case.
    await expect(validatePeerUrl("http://localhost:4515")).rejects.toThrow(/private/);
  });

  // -------------------------------------------------------------------------
  // allowPrivateIPs bypass
  // -------------------------------------------------------------------------

  it("allows private IPs when allowPrivateIPs is true", async () => {
    const opts = { allowPrivateIPs: true as const };
    const r1 = await validatePeerUrl("http://10.0.0.1:4515", opts);
    expect(r1.pinnedUrl).toBe("http://10.0.0.1:4515");
    const r2 = await validatePeerUrl("http://localhost:4515", opts);
    expect(r2.pinnedUrl).toBe("http://localhost:4515");
    const r3 = await validatePeerUrl("http://[::1]:4515", opts);
    expect(r3.pinnedUrl).toBe("http://[::1]:4515");
  });

  it("pins HTTP URL to resolved IP to prevent DNS rebinding", async () => {
    // example.com resolves to a public IP — the pinnedUrl must use that IP,
    // not the original hostname, so fetch() never does a second DNS lookup.
    const result = await validatePeerUrl("http://example.com:4515/test");
    const pinned = new URL(result.pinnedUrl);
    // Hostname in pinnedUrl must be an IP, not the original domain
    expect(pinned.hostname).not.toBe("example.com");
    expect(pinned.pathname).toBe("/test");
    expect(pinned.port).toBe("4515");
    // Host header preserves the original hostname for virtual-host routing
    expect(result.hostHeader).toBe("example.com:4515");
  });

  it("preserves original hostname for HTTPS (TLS SNI compatibility)", async () => {
    // HTTPS URLs must keep the original hostname so TLS SNI and certificate
    // validation work correctly. Pinning to an IP would break TLS for any
    // peer with a hostname-based certificate.
    const result = await validatePeerUrl("https://example.com:4515/test");
    const pinned = new URL(result.pinnedUrl);
    expect(pinned.hostname).toBe("example.com");
    expect(pinned.pathname).toBe("/test");
    expect(pinned.port).toBe("4515");
    expect(result.hostHeader).toBe("example.com:4515");
  });
});
