import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type AliasMap, DEFAULT_ALIASES } from "./data/aliases.js";
import { loadAliases } from "./data/aliases-loader.js";
import type { KeybindingOverrides, RemappableAction } from "./hooks/use-keybinding-overrides.js";
import { isKeyBindingId } from "./keymap/keymap.js";
import type { ThemeColorTokens } from "./theme.js";

export type ConfigFileKind = "aliases" | "hotkeys" | "theme";

export interface TuiConfigSnapshot {
  readonly aliases: AliasMap;
  readonly hotkeys: KeybindingOverrides;
  readonly theme: Partial<ThemeColorTokens>;
}

export type TuiConfigEvent =
  | {
      readonly type: "ConfigChanged";
      readonly changed: ConfigFileKind;
      readonly config: TuiConfigSnapshot;
    }
  | {
      readonly type: "ConfigError";
      readonly changed: ConfigFileKind;
      readonly message: string;
    };

export type TuiConfigSubscriber = (event: TuiConfigEvent) => void;

export interface TuiConfigWatcherOptions {
  readonly homeDir?: string | undefined;
  readonly projectRoot?: string | undefined;
  readonly debounceMs?: number | undefined;
}

export interface TuiConfigWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  current(): TuiConfigSnapshot;
  subscribe(subscriber: TuiConfigSubscriber): () => void;
}

interface FileLoadResult<T> {
  readonly value: T;
  readonly errors: readonly string[];
}

const EMPTY_SNAPSHOT: TuiConfigSnapshot = {
  aliases: DEFAULT_ALIASES,
  hotkeys: {},
  theme: {},
};

const HOTKEY_SCHEMA = z.record(z.string(), z.string().min(1));

const THEME_KEYS = [
  "focus",
  "inactive",
  "border",
  "running",
  "waiting",
  "idle",
  "error",
  "stale",
  "work",
  "review",
  "discussion",
  "adoption",
  "reproduction",
  "text",
  "secondary",
  "disabled",
  "panelBg",
  "headerBg",
  "selectedBg",
  "success",
  "warning",
  "info",
  "compare",
  "statusRunning",
  "statusDone",
  "statusFailed",
  "statusBlocked",
  "statusAwaitingReview",
  "statusIdle",
  "highlightMatch",
] as const satisfies readonly (keyof ThemeColorTokens)[];
const THEME_KEY_SET: ReadonlySet<string> = new Set(THEME_KEYS);
const THEME_SCHEMA = z.record(z.string(), z.string().min(1));

function isRemappableAction(action: string): action is RemappableAction {
  return isKeyBindingId(action);
}

function isThemeKey(key: string): key is keyof ThemeColorTokens {
  return THEME_KEY_SET.has(key);
}

async function readYamlRecord(
  filePath: string,
  schema: z.ZodType<Readonly<Record<string, string>>>,
): Promise<FileLoadResult<Readonly<Record<string, string>>>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { value: {}, errors: [] };
    return { value: {}, errors: [`${filePath}: ${e.message}`] };
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return { value: {}, errors: [`${filePath}: parse error - ${(err as Error).message}`] };
  }
  if (raw === null || raw === undefined) return { value: {}, errors: [] };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { value: {}, errors: [`${filePath}: schema error - ${parsed.error.message}`] };
  }

  return { value: parsed.data, errors: [] };
}

export async function loadHotkeysFile(
  filePath: string,
): Promise<FileLoadResult<KeybindingOverrides>> {
  const loaded = await readYamlRecord(filePath, HOTKEY_SCHEMA);
  if (loaded.errors.length > 0) return { value: {}, errors: loaded.errors };

  const hotkeys: Partial<Record<RemappableAction, string>> = {};
  const errors: string[] = [];
  for (const [action, key] of Object.entries(loaded.value)) {
    if (!isRemappableAction(action)) {
      errors.push(`${filePath}: unknown hotkey action "${action}"`);
      continue;
    }
    hotkeys[action] = key;
  }

  return errors.length > 0 ? { value: {}, errors } : { value: hotkeys, errors: [] };
}

export async function loadThemeFile(
  filePath: string,
): Promise<FileLoadResult<Partial<ThemeColorTokens>>> {
  const loaded = await readYamlRecord(filePath, THEME_SCHEMA);
  if (loaded.errors.length > 0) return { value: {}, errors: loaded.errors };

  const theme: Partial<ThemeColorTokens> = {};
  const errors: string[] = [];
  for (const [key, value] of Object.entries(loaded.value)) {
    if (!isThemeKey(key)) {
      errors.push(`${filePath}: unknown theme token "${key}"`);
      continue;
    }
    theme[key] = value;
  }

  return errors.length > 0 ? { value: {}, errors } : { value: theme, errors: [] };
}

class DefaultTuiConfigWatcher implements TuiConfigWatcher {
  private readonly homeDir: string;
  private readonly projectRoot: string | undefined;
  private readonly debounceMs: number;
  private readonly subscribers = new Set<TuiConfigSubscriber>();
  private readonly timers = new Map<ConfigFileKind, ReturnType<typeof setTimeout>>();
  private watcher: FSWatcher | undefined;
  private snapshot: TuiConfigSnapshot = EMPTY_SNAPSHOT;

  constructor(options: TuiConfigWatcherOptions = {}) {
    this.homeDir = options.homeDir ?? homedir();
    this.projectRoot = options.projectRoot;
    this.debounceMs = options.debounceMs ?? 75;
  }

  async start(): Promise<void> {
    if (this.watcher !== undefined) return;

    await Promise.all([this.reloadAliases(true), this.reloadHotkeys(true), this.reloadTheme(true)]);

    this.watcher = watch([...this.watchedPaths()], {
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    });
    this.watcher.on("all", (_event, filePath) => {
      const kind = this.kindForPath(String(filePath));
      if (kind !== undefined) this.scheduleReload(kind);
    });
    this.watcher.on("error", (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "ConfigError", changed: "aliases", message });
    });

    await new Promise<void>((resolveReady) => {
      const current = this.watcher;
      if (current === undefined) {
        resolveReady();
        return;
      }
      current.on("ready", () => resolveReady());
    });
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const current = this.watcher;
    this.watcher = undefined;
    if (current !== undefined) await current.close();
  }

  current(): TuiConfigSnapshot {
    return this.snapshot;
  }

  subscribe(subscriber: TuiConfigSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private userGroveDir(): string {
    return join(this.homeDir, ".grove");
  }

  private aliasesPaths(): readonly string[] {
    const paths = [join(this.userGroveDir(), "aliases.yaml")];
    if (this.projectRoot !== undefined)
      paths.push(join(this.projectRoot, ".grove", "aliases.yaml"));
    return paths;
  }

  private hotkeysPath(): string {
    return join(this.userGroveDir(), "hotkeys.yaml");
  }

  private themePath(): string {
    return join(this.userGroveDir(), "theme.yaml");
  }

  private watchedPaths(): readonly string[] {
    return [...this.aliasesPaths(), this.hotkeysPath(), this.themePath()];
  }

  private kindForPath(filePath: string): ConfigFileKind | undefined {
    const normalized = resolve(filePath);
    if (this.aliasesPaths().some((path) => resolve(path) === normalized)) return "aliases";
    if (resolve(this.hotkeysPath()) === normalized) return "hotkeys";
    if (resolve(this.themePath()) === normalized) return "theme";
    return undefined;
  }

  private scheduleReload(kind: ConfigFileKind): void {
    const existing = this.timers.get(kind);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(kind);
      void this.reloadKind(kind, true);
    }, this.debounceMs);
    this.timers.set(kind, timer);
  }

  private async reloadKind(kind: ConfigFileKind, emitChange: boolean): Promise<void> {
    switch (kind) {
      case "aliases":
        await this.reloadAliases(emitChange);
        return;
      case "hotkeys":
        await this.reloadHotkeys(emitChange);
        return;
      case "theme":
        await this.reloadTheme(emitChange);
        return;
    }
  }

  private async reloadAliases(emitChange: boolean): Promise<void> {
    const result = await loadAliases(this.projectRoot ?? this.homeDir, {
      homeOverride: this.homeDir,
    });
    if (result.errors.length > 0) {
      if (emitChange) this.emitError("aliases", result.errors[0] ?? "aliases.yaml failed to load");
      return;
    }
    this.snapshot = { ...this.snapshot, aliases: result.aliases };
    if (emitChange) this.emitChanged("aliases");
  }

  private async reloadHotkeys(emitChange: boolean): Promise<void> {
    const result = await loadHotkeysFile(this.hotkeysPath());
    if (result.errors.length > 0) {
      if (emitChange) this.emitError("hotkeys", result.errors[0] ?? "hotkeys.yaml failed to load");
      return;
    }
    this.snapshot = { ...this.snapshot, hotkeys: result.value };
    if (emitChange) this.emitChanged("hotkeys");
  }

  private async reloadTheme(emitChange: boolean): Promise<void> {
    const result = await loadThemeFile(this.themePath());
    if (result.errors.length > 0) {
      if (emitChange) this.emitError("theme", result.errors[0] ?? "theme.yaml failed to load");
      return;
    }
    this.snapshot = { ...this.snapshot, theme: result.value };
    if (emitChange) this.emitChanged("theme");
  }

  private emitChanged(changed: ConfigFileKind): void {
    this.emit({ type: "ConfigChanged", changed, config: this.snapshot });
  }

  private emitError(changed: ConfigFileKind, message: string): void {
    this.emit({ type: "ConfigError", changed, message });
  }

  private emit(event: TuiConfigEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

export function createTuiConfigWatcher(options: TuiConfigWatcherOptions = {}): TuiConfigWatcher {
  return new DefaultTuiConfigWatcher(options);
}
