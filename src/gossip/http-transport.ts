/**
 * HTTP-based gossip transport.
 *
 * Implements GossipTransport using Bun's built-in fetch() for
 * server-to-server communication. Uses standard keep-alive for
 * connection reuse.
 */

import { resolve4, resolve6 } from "node:dns/promises";

import { MAX_REQUEST_SIZE } from "../core/constants.js";
import { GossipTimeoutError, PeerUnreachableError } from "../core/gossip/errors.js";
import type {
  GossipMessage,
  GossipTransport,
  PeerInfo,
  ShuffleRequest,
  ShuffleResponse,
} from "../core/gossip/types.js";
import {
  GOSSIP_GET_SIGNATURE_HEADER,
  GOSSIP_GET_TIMESTAMP_HEADER,
  signGetRequest,
  verifyPayload,
} from "./protocol.js";

/**
 * Hard cap on the size of a single federation-fetched response body. Mirrors
 * the existing ingest cap (MAX_REQUEST_SIZE) so a peer cannot push a larger
 * artifact than the local server would accept on direct POST.
 */
const MAX_FEDERATION_RESPONSE_BYTES = MAX_REQUEST_SIZE;

// ---------------------------------------------------------------------------
// URL validation — SSRF prevention
// ---------------------------------------------------------------------------

/** Schemes allowed by default in peer URLs. */
const DEFAULT_ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * DNS hostnames that commonly resolve to dangerous internal endpoints.
 * Checked case-insensitively.
 */
const DANGEROUS_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data", // AWS alias used on some AMIs
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

/** Options for {@link validatePeerUrl}. */
export interface ValidatePeerUrlOptions {
  /** Extra schemes to allow beyond http/https. */
  readonly allowedSchemes?: ReadonlySet<string>;
  /** When true, private / reserved IP ranges are permitted. */
  readonly allowPrivateIPs?: boolean;
}

/**
 * Return true if `ip` falls in a non-global / private / reserved IPv4 range.
 *
 * Covers IANA-registered non-global ranges per RFC 6890 / RFC 5735:
 *  - 0.0.0.0/8           "This network"
 *  - 10.0.0.0/8          RFC 1918 private
 *  - 100.64.0.0/10       Shared address space (CGNAT, RFC 6598)
 *  - 127.0.0.0/8         Loopback
 *  - 169.254.0.0/16      Link-local (incl. AWS / GCP metadata)
 *  - 172.16.0.0/12       RFC 1918 private
 *  - 192.0.0.0/24        IETF Protocol Assignments
 *  - 192.0.2.0/24        TEST-NET-1
 *  - 192.168.0.0/16      RFC 1918 private
 *  - 198.18.0.0/15       Benchmarking
 *  - 198.51.100.0/24     TEST-NET-2
 *  - 203.0.113.0/24      TEST-NET-3
 *  - 224.0.0.0/4         Multicast
 *  - 240.0.0.0/4         Reserved for future use (covers 255.255.255.255)
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false; // not a valid IPv4 — let caller decide
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 (multicast)
  if (a >= 240) return true; // 240.0.0.0/4 (reserved) — also covers 255.255.255.255
  return false;
}

/**
 * Expand an IPv6 textual form to 8 16-bit groups. Handles `::` compression
 * and IPv4-mapped notation. Returns null on syntactic error.
 */
function expandIPv6(raw: string): number[] | null {
  const ip = raw.replace(/%.*$/, "").toLowerCase().replace(/^\[|\]$/g, "");

  // Handle IPv4-mapped suffix like ::ffff:1.2.3.4 — convert the dotted quad to
  // two 16-bit groups so the rest of the expansion is uniform hex.
  const dotted = ip.match(/^(.*?:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  let normalized = ip;
  if (dotted) {
    const prefix = dotted[1] ?? "";
    const quad = (dotted[2] as string).split(".").map(Number);
    if (quad.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0] as number) << 8) | (quad[1] as number);
    const lo = ((quad[2] as number) << 8) | (quad[3] as number);
    normalized = `${prefix}${hi.toString(16)}:${lo.toString(16)}`;
  }

  let leftParts: string[];
  let rightParts: string[];
  if (normalized.includes("::")) {
    if (normalized.split("::").length > 2) return null;
    const [left, right] = normalized.split("::");
    leftParts = left ? left.split(":") : [];
    rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) return null;
    leftParts = [...leftParts, ...Array(missing).fill("0"), ...rightParts];
    rightParts = [];
  } else {
    leftParts = normalized.split(":");
  }
  if (leftParts.length !== 8) return null;
  const groups: number[] = [];
  for (const g of leftParts) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

/**
 * Non-global / private / reserved IPv6 ranges (RFC 6890 special-purpose
 * registry, plus the IETF documentation/transition prefixes). Each entry
 * specifies the prefix length in bits and the first N 16-bit group values
 * (in network order) that must match.
 */
const IPV6_BLOCKED_PREFIXES: ReadonlyArray<{ prefix: number; groups: readonly number[] }> = [
  { prefix: 128, groups: [0, 0, 0, 0, 0, 0, 0, 0] }, // ::
  { prefix: 128, groups: [0, 0, 0, 0, 0, 0, 0, 1] }, // ::1
  { prefix: 96, groups: [0, 0, 0, 0, 0, 0xffff] }, // ::ffff:0:0/96 (IPv4-mapped)
  { prefix: 96, groups: [0x0064, 0xff9b] }, // 64:ff9b::/96 well-known NAT64
  { prefix: 48, groups: [0x0064, 0xff9b, 0x0001] }, // 64:ff9b:1::/48 local NAT64
  { prefix: 64, groups: [0x0100, 0, 0, 0] }, // 100::/64 discard
  { prefix: 23, groups: [0x2001] }, // 2001::/23 IETF protocol assignments
  { prefix: 32, groups: [0x2001, 0x0db8] }, // 2001:db8::/32 documentation
  { prefix: 16, groups: [0x2002] }, // 2002::/16 6to4
  { prefix: 7, groups: [0xfc00] }, // fc00::/7 unique local
  { prefix: 10, groups: [0xfe80] }, // fe80::/10 link-local
  { prefix: 10, groups: [0xfec0] }, // fec0::/10 deprecated site-local
  { prefix: 8, groups: [0xff00] }, // ff00::/8 multicast
];

function ipv6MatchesPrefix(addr: readonly number[], prefix: number, blocked: readonly number[]): boolean {
  let remaining = prefix;
  for (let i = 0; i < blocked.length && remaining > 0; i++) {
    const bits = Math.min(16, remaining);
    const mask = bits === 16 ? 0xffff : ((0xffff << (16 - bits)) & 0xffff) >>> 0;
    if (((addr[i] ?? 0) & mask) !== ((blocked[i] ?? 0) & mask)) return false;
    remaining -= bits;
  }
  return true;
}

/**
 * Return true if `ip` is a non-global / private / reserved IPv6 address.
 *
 * Handles `::` compression and IPv4-mapped suffixes. Covers the RFC 6890
 * special-purpose registry plus 6to4 (2002::/16), documentation
 * (2001:db8::/32), and deprecated site-local (fec0::/10). The IPv4-mapped
 * case (::ffff:a.b.c.d, in either dotted or hex form) is forwarded to
 * isPrivateIPv4 so the IPv4 ranges remain authoritative.
 */
function isPrivateIPv6(raw: string): boolean {
  const groups = expandIPv6(raw);
  if (!groups) return false;
  // IPv4-mapped (::ffff:0:0/96): hand off to the IPv4 classifier so the
  // canonical list of v4 private/reserved ranges applies.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const a = ((groups[6] as number) >> 8) & 0xff;
    const b = (groups[6] as number) & 0xff;
    const c = ((groups[7] as number) >> 8) & 0xff;
    const d = (groups[7] as number) & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }
  for (const { prefix, groups: blocked } of IPV6_BLOCKED_PREFIXES) {
    if (ipv6MatchesPrefix(groups, prefix, blocked)) return true;
  }
  return false;
}

/** Check whether a single resolved IP address is private/reserved. */
function isPrivateIP(ip: string): boolean {
  if (ip.includes(":")) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

/** Result of SSRF validation: a fetch-ready URL pinned to a resolved IP. */
export interface ValidatedUrl {
  /** URL with hostname replaced by the validated IP (use this for fetch). */
  readonly pinnedUrl: string;
  /** Original hostname to send in the Host header for virtual-host routing. */
  readonly hostHeader: string;
}

/**
 * Validate a peer URL to prevent Server-Side Request Forgery (SSRF).
 *
 * Returns a {@link ValidatedUrl} with the hostname replaced by the resolved
 * IP address. Callers MUST use `pinnedUrl` for the actual fetch and set the
 * `Host` header to `hostHeader`. This eliminates the DNS-rebinding TOCTOU
 * window: the resolved IP is validated and then used directly — fetch never
 * performs a second DNS lookup.
 *
 * Checks:
 *  1. URL is syntactically valid, scheme is http/https.
 *  2. Hostname is not in the dangerous-name denylist.
 *  3. IP literals are not in private/reserved ranges.
 *  4. DNS-resolved addresses are not in private/reserved ranges.
 *
 * @param url       - The raw URL string to validate.
 * @param options   - Optional overrides.
 * @returns A {@link ValidatedUrl} pinned to the validated IP.
 * @throws {Error}  A descriptive message when validation fails.
 */
export async function validatePeerUrl(
  url: string,
  options?: ValidatePeerUrlOptions,
): Promise<ValidatedUrl> {
  const allowedSchemes = options?.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES;
  const allowPrivate = options?.allowPrivateIPs === true;

  // 1. Parse ----------------------------------------------------------------
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid peer URL: unable to parse "${url}"`);
  }

  // 2. Scheme ---------------------------------------------------------------
  if (!allowedSchemes.has(parsed.protocol)) {
    throw new Error(
      `Invalid peer URL scheme "${parsed.protocol}" in "${url}". Allowed: ${[...allowedSchemes].join(", ")}`,
    );
  }

  // 3. Hostname must be present ---------------------------------------------
  const rawHostname = parsed.hostname; // already lowercased by URL constructor
  if (!rawHostname) {
    throw new Error(`Invalid peer URL: missing hostname in "${url}"`);
  }

  // Build the Host header value (hostname + non-default port).
  const portSuffix = parsed.port ? `:${parsed.port}` : "";
  const hostHeader = `${rawHostname}${portSuffix}`;

  // Short-circuit remaining checks when private IPs are explicitly allowed.
  if (allowPrivate) {
    return { pinnedUrl: url, hostHeader };
  }

  // Canonicalize: strip trailing dot (FQDN notation) so "localhost." matches "localhost".
  const hostname = rawHostname.endsWith(".") ? rawHostname.slice(0, -1) : rawHostname;

  // 4. Dangerous well-known hostnames ---------------------------------------
  if (DANGEROUS_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Peer URL rejected: hostname "${hostname}" resolves to a private/internal address`,
    );
  }

  // 5. IP-literal checks ----------------------------------------------------
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const looksLikeIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
  const looksLikeIPv6 = bare.includes(":");

  if (looksLikeIPv4 && isPrivateIPv4(bare)) {
    throw new Error(`Peer URL rejected: IPv4 address "${bare}" is in a private/reserved range`);
  }

  if (looksLikeIPv6 && isPrivateIPv6(bare)) {
    throw new Error(`Peer URL rejected: IPv6 address "${bare}" is in a private/reserved range`);
  }

  // If already an IP literal, no DNS rebinding risk — pin directly.
  if (looksLikeIPv4 || looksLikeIPv6) {
    return { pinnedUrl: url, hostHeader };
  }

  // 6. DNS resolution + pinning ---------------------------------------------
  // Resolve the hostname, validate all addresses, then rewrite the URL to
  // use the first safe IP. This makes fetch() connect to the validated IP
  // directly, eliminating the DNS-rebinding TOCTOU window.
  const resolved: string[] = [];
  try {
    const addrs = await resolve4(hostname);
    for (const addr of addrs) resolved.push(addr);
  } catch {
    // A lookup failed — may be IPv6-only, continue
  }
  try {
    const addrs = await resolve6(hostname);
    for (const addr of addrs) resolved.push(addr);
  } catch {
    // AAAA lookup failed — may be IPv4-only, continue
  }

  if (resolved.length === 0) {
    throw new Error(`Peer URL rejected: hostname "${hostname}" could not be resolved`);
  }

  for (const addr of resolved) {
    if (isPrivateIP(addr)) {
      throw new Error(
        `Peer URL rejected: hostname "${hostname}" resolves to private/reserved address ${addr}`,
      );
    }
  }

  // Pin the URL to the first resolved IP — but only for HTTP.
  // For HTTPS, TLS SNI and certificate validation require the original
  // hostname in the URL (fetch() uses the URL hostname for SNI, and the
  // server's certificate is checked against it). Rewriting to an IP would
  // break TLS for any peer with a hostname-based certificate.
  //
  // The DNS pre-flight check above still catches static rebinding (attacker
  // domain → private IP). For HTTPS, the remaining TOCTOU window is
  // mitigated by TLS certificate validation — an attacker who rebinds to
  // a private IP also needs a valid certificate for the original hostname.
  if (parsed.protocol === "https:") {
    return { pinnedUrl: url, hostHeader };
  }

  const pinnedIp = resolved[0] as string;
  const pinnedHost = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  const pinned = new URL(url);
  pinned.hostname = pinnedHost;
  return { pinnedUrl: pinned.toString(), hostHeader };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Configuration for the HTTP gossip transport. */
export interface HttpTransportConfig {
  /** Request timeout in milliseconds (default: 10_000). */
  readonly timeoutMs?: number | undefined;
  /**
   * When true, skip SSRF validation so that peers on private/reserved
   * networks can be reached. Only enable this for trusted environments.
   */
  readonly allowPrivateIPs?: boolean | undefined;
  /**
   * Shared HMAC-SHA256 secret used to verify signatures on peer responses.
   * When set, exchange responses and shuffle responses with invalid or missing
   * signatures are rejected before their data is merged.
   */
  readonly hmacSecret?: string | undefined;
}

/** Default request timeout: 10 seconds. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * HTTP-based GossipTransport.
 *
 * Sends gossip messages as JSON POST requests to peer grove-servers.
 * Uses Bun's built-in fetch() with default keep-alive for connection reuse.
 */
export class HttpGossipTransport implements GossipTransport {
  private readonly timeoutMs: number;
  private readonly allowPrivateIPs: boolean;
  private readonly hmacSecret: string | undefined;

  constructor(config?: HttpTransportConfig) {
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowPrivateIPs = config?.allowPrivateIPs ?? false;
    this.hmacSecret = config?.hmacSecret;
  }

  async exchange(peer: PeerInfo, message: GossipMessage): Promise<GossipMessage> {
    const url = `${peer.address}/api/gossip/exchange`;
    const validated = await validatePeerUrl(url, { allowPrivateIPs: this.allowPrivateIPs });
    const response = await this.post<GossipMessage>(validated, message, peer.peerId);
    if (
      this.hmacSecret &&
      !verifyPayload(response as unknown as Record<string, unknown>, this.hmacSecret)
    ) {
      throw new PeerUnreachableError({
        peerId: peer.peerId,
        address: validated.pinnedUrl,
        cause: new Error("exchange response: invalid or missing HMAC signature"),
      });
    }
    return response;
  }

  async shuffle(peer: PeerInfo, request: ShuffleRequest): Promise<ShuffleResponse> {
    const url = `${peer.address}/api/gossip/shuffle`;
    const validated = await validatePeerUrl(url, { allowPrivateIPs: this.allowPrivateIPs });
    const response = await this.post<ShuffleResponse>(validated, request, peer.peerId);
    if (
      this.hmacSecret &&
      !verifyPayload(response as unknown as Record<string, unknown>, this.hmacSecret)
    ) {
      throw new PeerUnreachableError({
        peerId: peer.peerId,
        address: validated.pinnedUrl,
        cause: new Error("shuffle response: invalid or missing HMAC signature"),
      });
    }
    return response;
  }

  /**
   * Fetch a contribution manifest by CID. Returns undefined on 404. Throws
   * PeerUnreachableError / GossipTimeoutError on network failure.
   *
   * HMAC verification is intentionally skipped: contributions are
   * content-addressed, and callers verify the manifest CID before storing.
   */
  async fetchContribution(peer: PeerInfo, cid: string): Promise<unknown | undefined> {
    const url = `${peer.address}/api/contributions/${encodeURIComponent(cid)}`;
    const validated = await validatePeerUrl(url, { allowPrivateIPs: this.allowPrivateIPs });
    return this.getJson<unknown>(validated, peer.peerId);
  }

  /**
   * Fetch an artifact's raw bytes by content hash. Returns undefined on 404.
   * Throws PeerUnreachableError / GossipTimeoutError on network failure.
   *
   * HMAC verification is intentionally skipped: callers MUST re-hash the
   * bytes and compare to the requested hash before storing.
   */
  async fetchArtifact(
    peer: PeerInfo,
    cid: string,
    artifactName: string,
  ): Promise<Uint8Array | undefined> {
    // Contribution-scoped: the peer's root contribution store resolves the
    // (cid, name) tuple and only returns bytes for artifacts referenced by a
    // root contribution. This keeps session-only artifacts in a shared CAS
    // from being reachable by federation.
    const url = `${peer.address}/api/contributions/${encodeURIComponent(cid)}/artifacts/${encodeURIComponent(artifactName)}`;
    const validated = await validatePeerUrl(url, { allowPrivateIPs: this.allowPrivateIPs });
    return this.getBytes(validated, peer.peerId);
  }

  private async post<T>(validated: ValidatedUrl, body: unknown, peerId: string): Promise<T> {
    const { pinnedUrl, hostHeader } = validated;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(pinnedUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: hostHeader,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "manual",
        });

        if (response.status >= 300 && response.status < 400) {
          throw new PeerUnreachableError({
            peerId,
            address: pinnedUrl,
            cause: new Error(
              `Peer returned redirect (HTTP ${response.status}); redirects are rejected to preserve SSRF protections`,
            ),
          });
        }
        if (!response.ok) {
          throw new PeerUnreachableError({
            peerId,
            address: pinnedUrl,
            cause: new Error(`HTTP ${response.status}: ${response.statusText}`),
          });
        }

        const bytes = await this.readWithCap(response, peerId, pinnedUrl);
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof PeerUnreachableError || err instanceof GossipTimeoutError) {
        throw err;
      }

      // AbortError from timeout
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new GossipTimeoutError({ peerId, timeoutMs: this.timeoutMs });
      }

      // Network errors (connection refused, DNS failure, etc.)
      throw new PeerUnreachableError({
        peerId,
        address: pinnedUrl,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Build the HMAC-signed headers for a peer GET request when a shared
   * gossip secret is configured. Returns an empty object when no secret is
   * set (the peer will fall back to bearer auth — this mode is only useful
   * for tests and one-off curl checks; in production GROVE_GOSSIP_HMAC_SECRET
   * is required when gossip is enabled).
   */
  private signedGetHeaders(path: string): Record<string, string> {
    if (!this.hmacSecret) return {};
    const ts = new Date().toISOString();
    return {
      [GOSSIP_GET_TIMESTAMP_HEADER]: ts,
      [GOSSIP_GET_SIGNATURE_HEADER]: signGetRequest("GET", path, ts, this.hmacSecret),
    };
  }

  /**
   * Read the response body up to a fixed byte cap, aborting if either the
   * advertised Content-Length or the streamed total exceeds it. Returns the
   * concatenated bytes when the body fits under the cap.
   */
  private async readWithCap(
    response: Response,
    peerId: string,
    pinnedUrl: string,
  ): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const declaredBytes = Number(declared);
      if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
        throw new PeerUnreachableError({
          peerId,
          address: pinnedUrl,
          cause: new Error(`Invalid Content-Length '${declared}'`),
        });
      }
      if (declaredBytes > MAX_FEDERATION_RESPONSE_BYTES) {
        throw new PeerUnreachableError({
          peerId,
          address: pinnedUrl,
          cause: new Error(
            `Response Content-Length ${declaredBytes} exceeds federation cap ${MAX_FEDERATION_RESPONSE_BYTES}`,
          ),
        });
      }
    }
    const body = response.body;
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_FEDERATION_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new PeerUnreachableError({
          peerId,
          address: pinnedUrl,
          cause: new Error(
            `Streamed response exceeded federation cap ${MAX_FEDERATION_RESPONSE_BYTES} bytes`,
          ),
        });
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  private async getJson<T>(validated: ValidatedUrl, peerId: string): Promise<T | undefined> {
    const { pinnedUrl, hostHeader } = validated;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const path = new URL(pinnedUrl).pathname;
        const response = await fetch(pinnedUrl, {
          method: "GET",
          headers: {
            Host: hostHeader,
            Accept: "application/json",
            ...this.signedGetHeaders(path),
          },
          signal: controller.signal,
          // Block automatic redirect-following: an attacker-controlled peer
          // could otherwise return a 3xx Location pointing at a private/
          // metadata endpoint and bypass our SSRF check.
          redirect: "manual",
        });
        if (response.status === 404) return undefined;
        if (response.status >= 300 && response.status < 400) {
          throw new PeerUnreachableError({
            peerId,
            address: pinnedUrl,
            cause: new Error(
              `Peer returned redirect (HTTP ${response.status}); redirects are rejected to preserve SSRF protections`,
            ),
          });
        }
        if (!response.ok) {
          throw new PeerUnreachableError({
            peerId,
            address: pinnedUrl,
            cause: new Error(`HTTP ${response.status}: ${response.statusText}`),
          });
        }
        const bytes = await this.readWithCap(response, peerId, pinnedUrl);
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof PeerUnreachableError || err instanceof GossipTimeoutError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new GossipTimeoutError({ peerId, timeoutMs: this.timeoutMs });
      }
      throw new PeerUnreachableError({
        peerId,
        address: pinnedUrl,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  private async getBytes(
    validated: ValidatedUrl,
    peerId: string,
  ): Promise<Uint8Array | undefined> {
    const { pinnedUrl, hostHeader } = validated;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const path = new URL(pinnedUrl).pathname;
        const response = await fetch(pinnedUrl, {
          method: "GET",
          headers: { Host: hostHeader, ...this.signedGetHeaders(path) },
          signal: controller.signal,
          redirect: "manual",
        });
        if (response.status === 404) return undefined;
        if (response.status >= 300 && response.status < 400) {
          throw new PeerUnreachableError({
            peerId,
            address: pinnedUrl,
            cause: new Error(
              `Peer returned redirect (HTTP ${response.status}); redirects are rejected to preserve SSRF protections`,
            ),
          });
        }
        if (!response.ok) {
          throw new PeerUnreachableError({
            peerId,
            address: pinnedUrl,
            cause: new Error(`HTTP ${response.status}: ${response.statusText}`),
          });
        }
        return await this.readWithCap(response, peerId, pinnedUrl);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (err instanceof PeerUnreachableError || err instanceof GossipTimeoutError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new GossipTimeoutError({ peerId, timeoutMs: this.timeoutMs });
      }
      throw new PeerUnreachableError({
        peerId,
        address: pinnedUrl,
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }
}
