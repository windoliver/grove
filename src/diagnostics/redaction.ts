export type ScrubMode = "standard" | "aggressive" | "off";

export interface RedactOptions {
  readonly mode: ScrubMode;
  readonly homeDir: string;
  readonly secretEnvKeys: readonly string[];
}

const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".log", ".yaml", ".yml"]);
const SECRET_ASSIGNMENT_KEYS = `"?(?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|TOKEN)"?`;

export function isTextEntryPath(path: string): boolean {
  if (path === "README.md") return true;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return !path.startsWith("db/");
  return TEXT_EXTENSIONS.has(path.slice(dot));
}

export function redactText(input: string, options: RedactOptions): string {
  if (options.mode === "off") return input;

  let out = input;
  out = redactSecretAssignments(out, options.secretEnvKeys);
  out = redactApiKeyAssignments(out);
  out = redactHomeDir(out, options.homeDir);
  out = redactEmails(out);
  out = redactSensitiveQueryParams(out);

  if (options.mode === "aggressive") {
    out = redactPrivateKeys(out);
    out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1<redacted>");
    out = redactAssignedAbsolutePaths(out);
  }

  return out;
}

function redactSecretAssignments(input: string, keys: readonly string[]): string {
  let out = input;
  for (const key of keys) {
    const escaped = escapeRegExp(key);
    out = redactAssignmentValues(out, `"?(?:${escaped})"?`, "g");
  }
  return out;
}

function redactApiKeyAssignments(input: string): string {
  return redactAssignmentValues(input, SECRET_ASSIGNMENT_KEYS, "gi");
}

function redactHomeDir(input: string, homeDir: string): string {
  if (homeDir.length === 0) return input;
  return input.replaceAll(homeDir, "~");
}

function redactEmails(input: string): string {
  return input.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted>");
}

function redactSensitiveQueryParams(input: string): string {
  return input.replace(/([?&](?:token|key|api_key|access_token)=)[^&#\s"']+/gi, "$1<redacted>");
}

function redactPrivateKeys(input: string): string {
  return input.replace(
    /(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g,
    "$1\n<redacted-private-key>\n$2",
  );
}

function redactAssignmentValues(input: string, keyPattern: string, flags: string): string {
  const quoted = new RegExp(
    `(${keyPattern}\\s*[=:]\\s*)(["'])(?:\\\\.|(?!\\2)[^\\r\\n])*?\\2`,
    flags,
  );
  const unquoted = new RegExp(`(${keyPattern}\\s*[=:]\\s*)[^&#\\s,}"']+`, flags);
  return input.replace(quoted, "$1$2<redacted>$2").replace(unquoted, "$1<redacted>");
}

function redactAssignedAbsolutePaths(input: string): string {
  const quoted = /((?:^|[{\s,])"?[A-Za-z0-9_.-]+"?\s*[=:]\s*)(["'])(\/(?:\\.|(?!\2)[^\r\n])*?)\2/g;
  const unquoted = /((?:^|[{\s,])"?[A-Za-z0-9_.-]+"?\s*[=:]\s*)\/[^\s"']+/g;

  return input
    .replace(quoted, (match, prefix: string, quote: string, path: string) =>
      isRouteLikePathValue(path) ? match : `${prefix}${quote}<redacted-path>${quote}`,
    )
    .replace(unquoted, (match, prefix: string) => {
      const path = match.slice(prefix.length);
      return isRouteLikePathValue(path) ? match : `${prefix}<redacted-path>`;
    });
}

function isRouteLikePathValue(path: string): boolean {
  const pathOnly = path.split(/[?&]/, 1)[0] ?? "";
  return pathOnly === "/api" || pathOnly.startsWith("/api/");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
