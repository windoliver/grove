/**
 * HTTP-based gossip transport.
 *
 * Implements GossipTransport using Bun's built-in fetch() for
 * server-to-server communication. Uses standard keep-alive for
 * connection reuse.
 */

import { resolve4, resolve6 } from "node:dns/promises";

import { GossipTimeoutError, PeerUnreachableError } from "../core/gossip/errors.js";
import type {
  GossipMessage,
  GossipTransport,
  PeerInfo,
  ShuffleRequest,
  ShuffleResponse,
} from "../core/gossip/types.js";

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
 * Return true if `ip` falls in a private or reserved IPv4 range.
 *
 * Ranges covered:
 *  - 0.0.0.0/8
 *  - 10.0.0.0/8
 *  - 127.0.0.0/8
 *  - 169.254.0.0/16
 *  - 172.16.0.0/12
 *  - 192.168.0.0/16
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false; // not a valid IPv4 — let caller decide
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/**
 * Return true if `ip` is a private or reserved IPv6 address.
 *
 * Covers:
 *  - ::1              (loopback)
 *  - fc00::/7         (unique local addresses, i.e. fc00:: – fdff::)
 *  - fe80::/10        (link-local)
 *  - ::ffff:x.x.x.x  (IPv4-mapped IPv6 — delegates to isPrivateIPv4)
 */
function isPrivateIPv6(raw: string): boolean {
  // Normalise: strip optional zone id (e.g. %eth0), lowercase
  const ip = raw.replace(/%.*$/, "").toLowerCase();
  if (ip === "::1") return true;

  // IPv4-mapped IPv6 addresses: ::ffff:a.b.c.d or ::ffff:HHHH:HHHH (hex form).
  // Runtimes may normalise the dotted-decimal form into two hex groups
  // (e.g. Bun turns ::ffff:127.0.0.1 into ::ffff:7f00:1). Both must be
  // checked against IPv4 private ranges to prevent SSRF bypass.
  const v4MappedDotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedDotted) {
    return isPrivateIPv4(v4MappedDotted[1] as string);
  }
  const v4MappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1] as string, 16);
    const lo = parseInt(v4MappedHex[2] as string, 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  // Expand the first group to check prefix bits.
  const firstGroup = ip.split(":")[0] ?? "";
  if (firstGroup === "") return false; // starts with "::", already checked ::1
  const val = parseInt(firstGroup, 16);
  if (Number.isNaN(val)) return false;

  // fc00::/7  → first byte 0xfc or 0xfd  → first 16-bit group 0xfc00–0xfdff
  if (val >= 0xfc00 && val <= 0xfdff) return true;
  // fe80::/10 → first 10 bits 0xfe80 → 0xfe80–0xfebf
  if (val >= 0xfe80 && val <= 0xfebf) return true;

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

  constructor(config?: HttpTransportConfig) {
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.allowPrivateIPs = config?.allowPrivateIPs ?? false;
  }

  async exchange(peer: PeerInfo, message: GossipMessage): Promise<GossipMessage> {
    const url = `${peer.address}/api/gossip/exchange`;
    const validated = await validatePeerUrl(url, { allowPrivateIPs: this.allowPrivateIPs });
    const response = await this.post<GossipMessage>(validated, message, peer.peerId);
    return response;
  }

  async shuffle(peer: PeerInfo, request: ShuffleRequest): Promise<ShuffleResponse> {
    const url = `${peer.address}/api/gossip/shuffle`;
    const validated = await validatePeerUrl(url, { allowPrivateIPs: this.allowPrivateIPs });
    const response = await this.post<ShuffleResponse>(validated, request, peer.peerId);
    return response;
  }

  private async post<T>(validated: ValidatedUrl, body: unknown, peerId: string): Promise<T> {
    const { pinnedUrl, hostHeader } = validated;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(pinnedUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Host: hostHeader },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new PeerUnreachableError({
            peerId,
            address: pinnedUrl,
            cause: new Error(`HTTP ${response.status}: ${response.statusText}`),
          });
        }

        return (await response.json()) as T;
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
}
