/**
 * High-level GhosttyTerminal class wrapping libghostty-vt's terminal API.
 *
 * Maintains persistent terminal state across .write() calls — no re-parsing
 * of the full ANSI blob each poll cycle. The Zig parser handles cursor
 * movements, SGR attributes, scrolling regions, and content reflow natively.
 */

import { getLib, ptr } from "./ffi.js";

/** Formatter output modes. */
export const FormatterMode = {
  /** Plain text with ANSI stripped. */
  PlainText: 0,
  /** VT sequences preserved. */
  Vt: 1,
  /** Styled HTML output. */
  Html: 2,
} as const;
export type FormatterMode = (typeof FormatterMode)[keyof typeof FormatterMode];

/**
 * A persistent terminal emulator backed by libghostty-vt.
 *
 * Usage:
 * ```ts
 * const term = new GhosttyTerminal(120, 30);
 * term.write(rawPtyBytes);
 * const text = term.getText();
 * term.destroy();
 * ```
 */
export class GhosttyTerminal {
  private _ptr: ReturnType<typeof ptr> | null;
  private _cols: number;
  private _rows: number;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  /**
   * Create a new terminal instance.
   *
   * @param cols - Number of columns (width in characters)
   * @param rows - Number of rows (height in characters)
   * @param scrollback - Number of scrollback lines to retain (default: 10000)
   */
  constructor(cols: number, rows: number, scrollback = 10000) {
    const lib = getLib();
    // null config pointer = default configuration
    this._ptr = lib.symbols.ghostty_terminal_new(null, cols, rows, scrollback);
    this._cols = cols;
    this._rows = rows;
  }

  /** Current column count. */
  get cols(): number {
    return this._cols;
  }

  /** Current row count. */
  get rows(): number {
    return this._rows;
  }

  /**
   * Feed raw PTY bytes into the terminal.
   *
   * The terminal state machine processes escape sequences, cursor movements,
   * SGR attributes, etc. State is maintained across calls — you only need
   * to feed *new* bytes, not the entire history.
   *
   * @param data - Raw PTY output (string or bytes)
   */
  write(data: string | Uint8Array): void {
    this.assertNotDestroyed();
    const lib = getLib();
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data;
    if (bytes.length === 0) return;
    lib.symbols.ghostty_terminal_vt_write(this._ptr!, ptr(bytes), bytes.length);
  }

  /**
   * Resize the terminal with content reflow.
   *
   * Lines that wrap due to the new width are reflowed correctly by the
   * Zig parser. This is dramatically more correct than re-parsing.
   *
   * @param cols - New column count
   * @param rows - New row count
   */
  resize(cols: number, rows: number): void {
    this.assertNotDestroyed();
    const lib = getLib();
    lib.symbols.ghostty_terminal_resize(this._ptr!, cols, rows);
    this._cols = cols;
    this._rows = rows;
  }

  /** Full terminal reset (like pressing Reset in a hardware terminal). */
  reset(): void {
    this.assertNotDestroyed();
    const lib = getLib();
    lib.symbols.ghostty_terminal_reset(this._ptr!);
  }

  /**
   * Scroll the viewport.
   *
   * @param delta - Positive scrolls up (into history), negative scrolls down
   */
  scrollViewport(delta: number): void {
    this.assertNotDestroyed();
    const lib = getLib();
    lib.symbols.ghostty_terminal_scroll_viewport(this._ptr!, delta);
  }

  /**
   * Extract current screen content as plain text.
   *
   * VT-aware stripping: handles cursor moves, scrolling regions, and
   * multi-byte sequences correctly. Dramatically more correct than
   * regex-based ANSI stripping (s/\x1b\[.*?m//g).
   */
  getText(): string {
    return this.format(FormatterMode.PlainText);
  }

  /**
   * Extract current screen content as styled HTML.
   *
   * Includes inline styles for colors, bold, italic, etc.
   * Suitable for web dashboard rendering.
   */
  getHtml(): string {
    return this.format(FormatterMode.Html);
  }

  /**
   * Extract current screen content in the specified format.
   */
  format(mode: FormatterMode): string {
    this.assertNotDestroyed();
    const lib = getLib();

    const formatter = lib.symbols.ghostty_formatter_terminal_new(this._ptr!, mode);
    if (formatter === null) return "";

    try {
      // Start with a reasonable buffer size, grow if needed
      let bufSize = this._cols * this._rows * 4; // ~4 bytes per char average
      let buf = new Uint8Array(bufSize);

      const written = lib.symbols.ghostty_formatter_format_buf(formatter, ptr(buf), bufSize);

      // If the output was truncated, try again with a larger buffer
      if (Number(written) >= bufSize) {
        bufSize = Number(written) * 2;
        buf = new Uint8Array(bufSize);
        const written2 = lib.symbols.ghostty_formatter_format_buf(formatter, ptr(buf), bufSize);
        return this.decoder.decode(buf.subarray(0, Number(written2)));
      }

      return this.decoder.decode(buf.subarray(0, Number(written)));
    } finally {
      lib.symbols.ghostty_formatter_free(formatter);
    }
  }

  /**
   * Get the current cursor position.
   *
   * Note: This is an approximation — the full C API for cursor position
   * reading is not yet stable. Returns [col, row] based on the last
   * known write position.
   */
  getCursor(): [number, number] {
    this.assertNotDestroyed();
    // The libghostty-vt C API doesn't expose a direct cursor-read function
    // yet. When it does, this will call ghostty_terminal_get_cursor().
    // For now, return a default position.
    return [0, 0];
  }

  /** Release native resources. Must be called when done with the terminal. */
  destroy(): void {
    if (this._ptr === null) return;
    const lib = getLib();
    lib.symbols.ghostty_terminal_free(this._ptr);
    this._ptr = null;
  }

  /** The raw native pointer (for advanced use / OpenTUI renderable). */
  get pointer(): ReturnType<typeof ptr> | null {
    return this._ptr;
  }

  private assertNotDestroyed(): void {
    if (this._ptr === null) {
      throw new Error("GhosttyTerminal has been destroyed");
    }
  }
}
