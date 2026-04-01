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

  export interface Timeline {
    add(
      target: object,
      props: Record<string, unknown> & {
        duration?: number;
        ease?: string;
        onUpdate?: (anim: { targets: object[] }) => void;
      },
      offset?: number,
    ): this;
    play(): this;
    pause(): this;
    reset(): this;
  }

  export interface UseTimelineOptions {
    duration?: number;
    loop?: boolean;
  }

  export function createRoot(renderer: CliRenderer): Root;
  export function useKeyboard(handler: (key: KeyEvent) => void, options?: UseKeyboardOptions): void;
  export function useRenderer(): CliRenderer;
  export function useTerminalDimensions(): { width: number; height: number };
  export function useTimeline(options?: UseTimelineOptions): Timeline;
  export function useOnResize(callback: () => void): void;
  export function extend<T extends Record<string, unknown>>(objects: T): void;
  export function flushSync(fn: () => void): void;
}

declare module "@opentui-ui/toast" {
  import type { CliRenderer } from "@opentui/core";

  export interface ToastOptions {
    description?: string;
    duration?: number;
    id?: string | number;
  }

  export interface Toast {
    success(message: string, options?: ToastOptions): string | number;
    error(message: string, options?: ToastOptions): string | number;
    info(message: string, options?: ToastOptions): string | number;
    warning(message: string, options?: ToastOptions): string | number;
    loading(message: string, options?: ToastOptions): string | number;
    message(message: string, options?: ToastOptions): string | number;
    dismiss(id?: string | number): void;
    getToasts(): unknown[];
    getHistory(): unknown[];
  }

  export const toast: Toast;

  export class ToasterRenderable {
    constructor(
      renderer: CliRenderer,
      options?: {
        position?: string;
        visibleToasts?: number;
        stackMode?: "single" | "stack";
      },
    );
  }

  export const ASCII_ICONS: Record<string, string>;
  export const EMOJI_ICONS: Record<string, string>;
  export const MINIMAL_ICONS: Record<string, string>;
  export const DEFAULT_ICONS: Record<string, string>;
  export const TOAST_DURATION: number;
}

declare module "@opentui-ui/toast/react" {
  import type { ReactNode } from "react";

  export interface ToasterProps {
    position?: string;
    visibleToasts?: number;
    stackMode?: "single" | "stack";
    children?: ReactNode;
  }

  export function Toaster(props: ToasterProps): ReactNode;
  export { toast } from "@opentui-ui/toast";
  export function useToasts(): unknown[];
}

declare module "@opentui-ui/dialog" {
  import type { CliRenderer } from "@opentui/core";

  export interface DialogShowOptions {
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }

  export class DialogManager {
    constructor(renderer: CliRenderer, options?: { theme?: object });
    confirm(options: DialogShowOptions): Promise<boolean>;
    alert(options: DialogShowOptions): Promise<void>;
    prompt(options: DialogShowOptions & { defaultValue?: string }): Promise<string | null>;
    choice(options: DialogShowOptions & { choices: string[] }): Promise<string | null>;
    show(options: DialogShowOptions): string;
    close(id: string): void;
    closeAll(): void;
    isOpen(): boolean;
    destroy(): void;
    isDestroyed(): boolean;
  }

  export const themes: {
    minimal: object;
    unstyled: object;
  };
}

declare module "@opentui-ui/dialog/react" {
  import type { ReactNode } from "react";

  export interface DialogProviderProps {
    theme?: object;
    children?: ReactNode;
  }

  export interface DialogHook {
    confirm(options: { title?: string; message?: string }): Promise<boolean>;
    alert(options: { title?: string; message?: string }): Promise<void>;
    prompt(options: {
      title?: string;
      message?: string;
      defaultValue?: string;
    }): Promise<string | null>;
    choice(options: {
      title?: string;
      message?: string;
      choices: string[];
    }): Promise<string | null>;
    show(options: { title?: string; message?: string }): string;
    closeAll(): void;
    isOpen(): boolean;
  }

  export function DialogProvider(props: DialogProviderProps): ReactNode;
  export function useDialog(): DialogHook;
  export function useDialogKeyboard(
    handler: (key: import("@opentui/core").KeyEvent) => void,
    dialogId?: string,
  ): void;
  export function useDialogState<T>(selector: (state: unknown) => T): T;
  export { themes } from "@opentui-ui/dialog";
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
