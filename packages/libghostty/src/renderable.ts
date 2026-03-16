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
 * Usage:
 * ```tsx
 * // Stateless mode (full re-parse each render):
 * <ghostty-terminal ansi={rawOutput} cols={120} rows={30} />
 *
 * // Persistent mode (delta-only feeding, no reset):
 * <ghostty-terminal delta={newBytes} cols={120} rows={30} />
 * ```
 */

import { GhosttyTerminal } from "./terminal.js";

/**
 * OpenTUI renderable class for terminal output.
 *
 * Two rendering modes:
 *
 * **Stateless** (via `ansi` prop): Resets the terminal and feeds the
 * entire ANSI blob on every getText() call. Simple but re-parses everything.
 *
 * **Persistent** (via `delta` prop): Only feeds the new bytes since the
 * last render. Terminal state (cursor, colors, scrollback) is maintained
 * across calls. This is the mode used for per-agent persistent terminals.
 *
 * The prop is named `delta` (not `feed`) to avoid collision with the
 * `appendData()` imperative method.
 */
export class GhosttyRenderable {
  private _ansi: string | Buffer | Uint8Array = "";
  private _delta: string | Buffer | Uint8Array | undefined;
  private _cols = 120;
  private _rows = 30;
  private _trimEnd = false;
  private _terminal: GhosttyTerminal | null = null;
  private _persistentMode = false;

  constructor(_ctx: unknown, _options: Record<string, unknown>) {
    // OpenTUI passes renderer context and options to constructors
  }

  // -- Props set by OpenTUI reconciler via property assignment --

  get ansi(): string | Buffer | Uint8Array {
    return this._ansi;
  }

  set ansi(value: string | Buffer | Uint8Array) {
    this._ansi = value;
    // ansi prop = stateless mode (full re-parse)
    this._persistentMode = false;
  }

  /**
   * Delta bytes for persistent mode.
   * When set, getText() does NOT reset the terminal — it only feeds
   * the delta, preserving cursor/color/scrollback state.
   */
  get delta(): string | Buffer | Uint8Array | undefined {
    return this._delta;
  }

  set delta(value: string | Buffer | Uint8Array | undefined) {
    this._delta = value;
    if (value !== undefined) {
      this._persistentMode = true;
    }
  }

  get cols(): number {
    return this._cols;
  }

  set cols(value: number) {
    if (this._cols !== value) {
      this._cols = value;
      if (this._terminal) {
        this._terminal.resize(this._cols, this._rows);
      }
    }
  }

  get rows(): number {
    return this._rows;
  }

  set rows(value: number) {
    if (this._rows !== value) {
      this._rows = value;
      if (this._terminal) {
        this._terminal.resize(this._cols, this._rows);
      }
    }
  }

  get trimEnd(): boolean {
    return this._trimEnd;
  }

  set trimEnd(value: boolean) {
    this._trimEnd = value;
  }

  // -- Rendering --

  /**
   * Get the rendered text content for OpenTUI's text buffer.
   * Called by OpenTUI's reconciler on each render frame.
   */
  getText(): string {
    if (!this._terminal) {
      this._terminal = new GhosttyTerminal(this._cols, this._rows, 0);
    }

    if (this._persistentMode && this._delta !== undefined) {
      // Persistent mode: feed only the delta, no reset
      this.writeToTerminal(this._delta);
      this._delta = undefined;
    } else if (!this._persistentMode) {
      // Stateless mode: reset and feed the full content
      this._terminal.reset();
      this.writeToTerminal(this._ansi);
    }
    // If persistent mode but no delta, just return current state (no-op)

    let text = this._terminal.getText();
    if (this._trimEnd) {
      text = text.trimEnd();
    }
    return text;
  }

  // -- Imperative API (for direct usage outside OpenTUI props) --

  /**
   * Append data to the persistent terminal.
   * For streaming mode — avoids re-parsing the entire history.
   */
  appendData(data: string | Buffer | Uint8Array): void {
    if (!this._terminal) {
      this._terminal = new GhosttyTerminal(this._cols, this._rows, 0);
    }
    this._persistentMode = true;
    this.writeToTerminal(data);
  }

  /** Reset the terminal state. */
  reset(): void {
    this._terminal?.reset();
    this._persistentMode = false;
    this._delta = undefined;
  }

  /** Release native resources. */
  destroy(): void {
    this._terminal?.destroy();
    this._terminal = null;
  }

  // -- Internal --

  private writeToTerminal(input: string | Buffer | Uint8Array): void {
    if (!this._terminal) return;
    if (typeof input === "string") {
      this._terminal.write(input);
    } else if (input instanceof Uint8Array) {
      this._terminal.write(input);
    } else if (Buffer.isBuffer(input)) {
      this._terminal.write(new Uint8Array(input));
    }
  }
}
