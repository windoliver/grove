/**
 * Type declarations for OpenTUI packages.
 *
 * These packages have correct runtime exports but incomplete TypeScript
 * declarations for NodeNext module resolution. This file provides the
 * minimal type surface needed by the TUI.
 */

declare module "@opentui/core" {
  export interface CliRendererConfig {
    stdin?: NodeJS.ReadStream;
    stdout?: NodeJS.WriteStream;
    exitOnCtrlC?: boolean;
    useAlternateScreen?: boolean;
    targetFps?: number;
    maxFps?: number;
    useMouse?: boolean;
    autoFocus?: boolean;
  }

  export interface CliRenderer {
    root: unknown;
    width: number;
    height: number;
    start(): void;
    stop(): void;
    destroy(): void;
    idle(): Promise<void>;
    requestRender(): void;
  }

  export interface KeyEvent {
    name: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    option: boolean;
    sequence: string;
    raw: string;
    eventType: "press" | "release";
    repeated?: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  }

  export function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>;
}

declare module "@opentui/react" {
  import type { ReactNode } from "react";
  import type { CliRenderer, KeyEvent } from "@opentui/core";

  export interface Root {
    render(node: ReactNode): void;
    unmount(): void;
  }

  export interface UseKeyboardOptions {
    release?: boolean;
  }

  export function createRoot(renderer: CliRenderer): Root;
  export function useKeyboard(handler: (key: KeyEvent) => void, options?: UseKeyboardOptions): void;
  export function useRenderer(): CliRenderer;
  export function useTerminalDimensions(): { width: number; height: number };
  export function extend<T extends Record<string, unknown>>(objects: T): void;
}

declare module "ghostty-opentui" {
  export function ptyToJson(
    input: Buffer | Uint8Array | string,
    options?: { cols?: number; rows?: number },
  ): unknown;

  export function ptyToText(
    input: Buffer | Uint8Array | string,
    options?: { cols?: number; rows?: number },
  ): string;
}

declare module "ghostty-opentui/terminal-buffer" {
  export class GhosttyTerminalRenderable {
    constructor(ctx: unknown, options: Record<string, unknown>);
    get ansi(): string | Buffer | Uint8Array;
    set ansi(value: string | Buffer | Uint8Array);
    get cols(): number;
    set cols(value: number);
    get rows(): number;
    set rows(value: number);
    feed(data: string | Buffer | Uint8Array): void;
    reset(): void;
    getText(): string;
    destroy(): void;
  }
}

declare module "ghostty-opentui/opentui" {
  export { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
}
