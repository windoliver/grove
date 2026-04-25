/**
 * Git origin URL detection and normalization.
 *
 * Normalization collapses the common "same repo, different URL" cases
 * (HTTPS vs SSH, with/without .git suffix, with/without port, mixed case
 * host) to a single canonical key of the form "host/path" with the host
 * lowercased and the path case preserved.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";

const SCHEME_RE = /^(?:https?|ssh|git|git\+ssh):\/\//i;

export function normalizeOriginUrl(raw: string): string | null {
  if (!raw) return null;

  let s = raw.trim();
  if (!s) return null;

  // Reject schemes we don't correlate (file://, local paths).
  if (s.toLowerCase().startsWith("file://")) return null;

  // Reject filesystem paths — absolute (/foo, ~/foo, C:\foo), relative
  // (./foo, ../foo), or bare relative paths with no host (foo/bar.git).
  // These belong to a single machine and must not become registry keys.
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~")) {
    return null;
  }
  if (/^[a-zA-Z]:[\\/]/.test(s)) return null; // Windows drive letter

  // 1. Strip known scheme.
  const hadScheme = SCHEME_RE.test(s);
  if (hadScheme) s = s.replace(SCHEME_RE, "");

  // Without a scheme, require strict SCP form (host:path with no slash
  // before the colon). Anything else — including dotted relative paths
  // like "github.com/foo.git" which git treats as a filesystem directory —
  // is rejected so we don't pollute the cross-machine registry.
  if (!hadScheme) {
    const colonIdx = s.indexOf(":");
    const slashIdx = s.indexOf("/");
    const isScpForm = colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx);
    if (!isScpForm) return null;
  }

  // 2. Strip leading user@ (with scheme: terminator is '/' only, since
  //    `user:password@host/path` is legal HTTPS auth — colon is part of
  //    user-info. Without scheme: SCP form `user@host:path`, terminator is
  //    '/' or ':').
  const atIdx = s.indexOf("@");
  if (atIdx > -1) {
    const slashIdx = s.indexOf("/");
    const hardSep = hadScheme
      ? slashIdx === -1
        ? Number.POSITIVE_INFINITY
        : slashIdx
      : Math.min(
          ...["/", ":"].map((c) => {
            const i = s.indexOf(c);
            return i === -1 ? Number.POSITIVE_INFINITY : i;
          }),
        );
    if (atIdx < hardSep) {
      s = s.slice(atIdx + 1);
    }
  }

  // 3. SCP-style host:path → host/path (only when there is no '/' before the ':').
  if (!hadScheme) {
    const colonIdx = s.indexOf(":");
    const slashIdx = s.indexOf("/");
    if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
      s = `${s.slice(0, colonIdx)}/${s.slice(colonIdx + 1)}`;
    }
  }

  // 4. Strip :<port> between host and '/'.
  const portMatch = s.match(/^([^/:]+):(\d+)\//);
  if (portMatch) {
    s = `${portMatch[1]}/${s.slice(portMatch[0].length)}`;
  }

  // 5. Strip trailing .git.
  if (s.toLowerCase().endsWith(".git")) s = s.slice(0, -4);

  // 6. Strip trailing /.
  while (s.endsWith("/")) s = s.slice(0, -1);

  // 7. Lowercase host (characters up to the first '/').
  const firstSlash = s.indexOf("/");
  if (firstSlash === -1) return null;
  s = `${s.slice(0, firstSlash).toLowerCase()}${s.slice(firstSlash)}`;

  // 8. Reject if no path part after host.
  const afterSlash = s.slice(firstSlash + 1);
  if (!afterSlash) return null;

  return s;
}

/**
 * Strip credential userinfo from a URL-like string for safe logging.
 *
 * - `https://user:pass@host/path` → `https://host/path`
 * - `git@host:path` → `host:path`
 * - Anything else → returned unchanged.
 *
 * Use this on raw origin strings before writing to stderr/stdout/log files.
 */
export function sanitizeOriginForLog(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  const schemeMatch = s.match(/^(https?|ssh|git|git\+ssh):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[0];
    const rest = s.slice(scheme.length);
    const atIdx = rest.indexOf("@");
    const slashIdx = rest.indexOf("/");
    if (atIdx > -1 && (slashIdx === -1 || atIdx < slashIdx)) {
      s = `${scheme}${rest.slice(atIdx + 1)}`;
    }
    return s;
  }
  // SCP-style: strip "user@" prefix when present and before the ':'.
  const atIdx = s.indexOf("@");
  const colonIdx = s.indexOf(":");
  if (atIdx > 0 && colonIdx > atIdx) {
    s = s.slice(atIdx + 1);
  }
  return s;
}

export function detectOriginUrl(cwd: string): string | null {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  if (result.error) return null;
  if (result.status !== 0) return null;
  const out = (result.stdout ?? "").trim();
  return out === "" ? null : out;
}
