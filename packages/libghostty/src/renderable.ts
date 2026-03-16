/**
 * OpenTUI custom component for rendering terminal output via libghostty-vt.
 *
 * Replaces the ghostty-opentui/opentui GhosttyTerminalRenderable with our
 * own implementation backed by @grove/libghostty. Supports persistent mode
 * where the terminal state is maintained across feeds.
 *
 * Registration:
 * ```ts
 * import { extend } from "@opentui/react";
 * import { GhosttyRenderable } from "@grove/libghostty/renderable";
 * extend({ "ghostty-terminal": GhosttyRenderable });
 * ```
 *
 * Usage (unchanged from ghostty-opentui):
 * ```tsx
 * <ghostty-terminal ansi={rawOutput} cols={120} rows={30} />
 * ```
 */

import { GhosttyTerminal } from "./terminal.js";

/**
 * OpenTUI renderable class for terminal output.
 *
 * This is a TextBufferRenderable-compatible class that OpenTUI's
 * extend() function registers as a custom intrinsic element.
 *
 * When `ansi` prop changes, it feeds the *entire* content to a fresh
 * terminal instance (stateless mode). For persistent mode, use
 * GhosttyTerminal directly and call .write() with deltas.
 */
export class GhosttyRenderable {
  private _ansi: string | Buffer | Uint8Array = "";
  private _feed: string | Buffer | Uint8Array | undefined;
  private _cols = 120;
  private _rows = 30;
  private _trimEnd = false;
  private _terminal: GhosttyTerminal | null = null;
  private _persistentMode = false;

  constructor(_ctx: unknown, _options: Record<string, unknown>) {
    // OpenTUI passes renderer context and options to constructors
  }

  get ansi(): string | Buffer | Uint8Array {
    return this._ansi;
  }

  set ansi(value: string | Buffer | Uint8Array) {
    this._ansi = value;
    // When ansi is set, use stateless mode (full re-parse)
    this._persistentMode = false;
    this.invalidate();
  }

  /**
   * Feed delta bytes for persistent mode.
   * When set, the terminal is NOT reset — new bytes are appended
   * to the existing state, avoiding full re-parse.
   */
  set feed(value: string | Buffer | Uint8Array) {
    this._feed = value;
    this._persistentMode = true;
  }

  get cols(): number {
    return this._cols;
  }

  set cols(value: number) {
    if (this._cols !== value) {
      this._cols = value;
      this.invalidate();
    }
  }

  get rows(): number {
    return this._rows;
  }

  set rows(value: number) {
    if (this._rows !== value) {
      this._rows = value;
      this.invalidate();
    }
  }

  get trimEnd(): boolean {
    return this._trimEnd;
  }

  set trimEnd(value: boolean) {
    this._trimEnd = value;
  }

  /**
   * Get the rendered text content for OpenTUI's text buffer.
   *
   * This is called by OpenTUI's reconciler to get the content to display.
   */
  getText(): string {
    if (!this._terminal) {
      this._terminal = new GhosttyTerminal(this._cols, this._rows, 0);
    }

    if (this._persistentMode && this._feed !== undefined) {
      // Persistent mode: feed only the delta bytes, no reset
      this.writeInput(this._feed);
      this._feed = undefined;
    } else {
      // Stateless mode: reset and feed the full content
      this._terminal.reset();
      this.writeInput(this._ansi);
    }

    let text = this._terminal.getText();
    if (this._trimEnd) {
      text = text.trimEnd();
    }
    return text;
  }

  /** Write input data to the terminal, handling type conversion. */
  private writeInput(input: string | Buffer | Uint8Array): void {
    if (!this._terminal) return;
    if (typeof input === "string") {
      this._terminal.write(input);
    } else if (input instanceof Uint8Array) {
      this._terminal.write(input);
    } else if (Buffer.isBuffer(input)) {
      this._terminal.write(new Uint8Array(input));
    }
  }

  /**
   * Feed additional data to a persistent terminal.
   *
   * For streaming mode — avoids re-parsing the entire history.
   */
  feed(data: string | Buffer | Uint8Array): void {
    if (!this._terminal) {
      this._terminal = new GhosttyTerminal(this._cols, this._rows, 0);
    }
    if (typeof data === "string") {
      this._terminal.write(data);
    } else if (data instanceof Uint8Array) {
      this._terminal.write(data);
    } else if (Buffer.isBuffer(data)) {
      this._terminal.write(new Uint8Array(data));
    }
  }

  /** Reset the terminal state. */
  reset(): void {
    this._terminal?.reset();
  }

  /** Release native resources. */
  destroy(): void {
    this._terminal?.destroy();
    this._terminal = null;
  }

  private invalidate(): void {
    // Resize the terminal if dimensions changed
    if (this._terminal) {
      if (this._terminal.cols !== this._cols || this._terminal.rows !== this._rows) {
        this._terminal.resize(this._cols, this._rows);
      }
    }
  }
}
