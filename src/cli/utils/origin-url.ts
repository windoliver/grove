/**
 * Git origin URL detection and normalization.
 *
 * Normalization collapses the common "same repo, different URL" cases
 * (HTTPS vs SSH, with/without .git suffix, with/without port, mixed case
 * host) to a single canonical key of the form "host/path" with the host
 * lowercased and the path case preserved.
 */

import { spawnSync } from "node:child_process";

const SCHEME_RE = /^(?:https?|ssh|git|git\+ssh):\/\//i;

export function normalizeOriginUrl(raw: string): string | null {
  if (!raw) return null;

  let s = raw.trim();
  if (!s) return null;

  // Reject schemes we don't correlate (file://, local paths).
  if (s.toLowerCase().startsWith("file://")) return null;

  // 1. Strip known scheme.
  const hadScheme = SCHEME_RE.test(s);
  if (hadScheme) s = s.replace(SCHEME_RE, "");

  // 2. Strip leading user@ (only if it appears before the first '/' or ':').
  const atIdx = s.indexOf("@");
  if (atIdx > -1) {
    const firstSep = Math.min(
      ...["/", ":"].map((c) => {
        const i = s.indexOf(c);
        return i === -1 ? Number.POSITIVE_INFINITY : i;
      }),
    );
    if (atIdx < firstSep) {
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

export function detectOriginUrl(cwd: string): string | null {
  let result: ReturnType<typeof spawnSync>;
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
