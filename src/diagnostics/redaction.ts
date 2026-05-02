export type ScrubMode = "standard" | "aggressive" | "off";

export interface RedactOptions {
  readonly mode: ScrubMode;
  readonly homeDir: string;
  readonly secretEnvKeys: readonly string[];
}

const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".log", ".yaml", ".yml"]);

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
    out = out.replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1<redacted>");
    out = out.replace(/(?<==)\/(?:private|tmp|var|opt|Users)\/[^\s"']+/g, "<redacted-path>");
  }

  return out;
}

function redactSecretAssignments(input: string, keys: readonly string[]): string {
  let out = input;
  for (const key of keys) {
    const escaped = escapeRegExp(key);
    out = out.replace(new RegExp(`(${escaped}\\s*[=:]\\s*)[^\\s,}"']+`, "g"), "$1<redacted>");
  }
  return out;
}

function redactApiKeyAssignments(input: string): string {
  return input.replace(
    /((?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|TOKEN)\s*[=:]\s*)[^&#\s,}"']+/gi,
    "$1<redacted>",
  );
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

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
