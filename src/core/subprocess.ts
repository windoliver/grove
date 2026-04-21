/**
 * Shared process-spawning utility.
 *
 * Wraps Bun.spawn with consistent stdout/stderr collection,
 * exit code checking, and timeout support. Used by git ingest
 * modules and the GitHub adapter.
 */

/** Result of a spawned command. */
export interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Options for spawnCommand. */
export interface SpawnOptions {
  /** Working directory for the command. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Timeout in milliseconds. Defaults to 30_000 (30s). */
  readonly timeoutMs?: number;
  /** Maximum buffered output size per stream in bytes. Defaults to 10MB. */
  readonly maxBufferBytes?: number;
}

/** Default timeout: 30 seconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default max buffer: 10 MB. */
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBufferBytes: number,
  label: "stdout" | "stderr",
  onOverflow: () => void,
): Promise<string> {
  if (stream === null) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBufferBytes) {
        onOverflow();
        throw new Error(`${label} exceeded max buffer of ${maxBufferBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/**
 * Spawn a command and collect its output.
 *
 * @param cmd - Command and arguments (e.g., ["git", "ls-files"]).
 * @param options - Spawn options (cwd, timeout, maxBuffer).
 * @returns SpawnResult with stdout, stderr, and exitCode.
 * @throws If the command times out.
 */
export async function spawnCommand(
  cmd: readonly string[],
  options?: SpawnOptions,
): Promise<SpawnResult> {
  const cwd = options?.cwd ?? process.cwd();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  let proc: import("bun").Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...cmd], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err: unknown) {
    // Bun.spawn throws immediately when the executable is not found in $PATH.
    // Return a synthetic non-zero result so callers can handle it uniformly.
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, exitCode: 127 };
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd.join(" ")}`));
    }, timeoutMs);
    // Allow the process to finish without keeping the timer alive
    proc.exited.then(
      () => clearTimeout(id),
      () => clearTimeout(id),
    );
  });

  const collectPromise = async (): Promise<SpawnResult> => {
    let overflowed = false;
    const killForOverflow = (): void => {
      if (overflowed) return;
      overflowed = true;
      proc.kill();
    };
    const [stdout, stderr] = await Promise.all([
      readStreamWithLimit(proc.stdout, maxBufferBytes, "stdout", killForOverflow),
      readStreamWithLimit(proc.stderr, maxBufferBytes, "stderr", killForOverflow),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  };

  return Promise.race([collectPromise(), timeoutPromise]);
}

/**
 * Spawn a command and return stdout, throwing on non-zero exit.
 *
 * Convenience wrapper over spawnCommand for the common case where
 * any non-zero exit code is an error.
 *
 * @param cmd - Command and arguments.
 * @param options - Spawn options.
 * @param errorPrefix - Prefix for error message (e.g., "git ls-files").
 * @returns stdout as a string.
 * @throws If the command exits with non-zero code or times out.
 */
export async function spawnOrThrow(
  cmd: readonly string[],
  options?: SpawnOptions,
  errorPrefix?: string,
): Promise<string> {
  const result = await spawnCommand(cmd, options);
  if (result.exitCode !== 0) {
    const prefix = errorPrefix ?? cmd.join(" ");
    throw new Error(`${prefix} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}
