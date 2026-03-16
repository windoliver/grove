/**
 * HTML extraction from terminal output via @xterm/headless + serialize addon.
 *
 * Converts raw PTY/ANSI output to styled HTML for web dashboard rendering.
 * Uses xterm's headless terminal for full VT emulation and the serialize
 * addon for HTML output with inline styles.
 */

let cachedTerminal: import("@xterm/headless").Terminal | null = null;
let serializeAddon: import("@xterm/addon-serialize").SerializeAddon | null = null;

/**
 * Convert raw PTY output to styled HTML.
 *
 * The HTML includes inline styles for colors, bold, italic, etc.
 * Suitable for embedding in web dashboard pages.
 *
 * @param input - Raw PTY/ANSI output
 * @param options - Terminal dimensions for emulation
 * @returns HTML string with styled content
 */
export async function ptyToHtml(
  input: string,
  options?: { cols?: number; rows?: number },
): Promise<string> {
  const cols = options?.cols ?? 120;
  const rows = options?.rows ?? 30;

  const { Terminal } = await import("@xterm/headless");
  const { SerializeAddon } = await import("@xterm/addon-serialize");

  // Reuse terminal instance for performance
  if (!cachedTerminal || cachedTerminal.cols !== cols || cachedTerminal.rows !== rows) {
    cachedTerminal?.dispose();
    cachedTerminal = new Terminal({ cols, rows, scrollback: 0 });
    serializeAddon = new SerializeAddon();
    cachedTerminal.loadAddon(serializeAddon);
  }

  cachedTerminal.reset();
  cachedTerminal.write(input);

  // Wait for write to be processed
  await new Promise<void>((resolve) => {
    cachedTerminal?.write("", resolve);
  });

  return serializeAddon?.serializeAsHTML() ?? "";
}

/**
 * Convert raw PTY output to plain text with proper VT emulation.
 *
 * Handles cursor movements, scrolling regions, and reflow correctly —
 * unlike simple regex-based ANSI stripping.
 *
 * @param input - Raw PTY/ANSI output
 * @param options - Terminal dimensions for emulation
 * @returns Clean plain text
 */
export async function ptyToText(
  input: string,
  options?: { cols?: number; rows?: number },
): Promise<string> {
  const cols = options?.cols ?? 120;
  const rows = options?.rows ?? 30;

  const { Terminal } = await import("@xterm/headless");

  const terminal = new Terminal({ cols, rows, scrollback: 0 });
  terminal.write(input);

  await new Promise<void>((resolve) => {
    terminal.write("", resolve);
  });

  const buf = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }

  terminal.dispose();

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }

  return lines.join("\n");
}
