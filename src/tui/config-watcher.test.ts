import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiConfigWatcher } from "./config-watcher.js";

const cleanupDirs: string[] = [];

async function makeFixture(): Promise<{
  readonly root: string;
  readonly homeDir: string;
  readonly projectRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "grove-config-watch-"));
  cleanupDirs.push(root);
  const homeDir = join(root, "home");
  const projectRoot = join(root, "project");
  await mkdir(join(homeDir, ".grove"), { recursive: true });
  await mkdir(join(projectRoot, ".grove"), { recursive: true });
  return { root, homeDir, projectRoot };
}

function waitFor<T>(fn: () => T | undefined, timeoutMs = 500): Promise<T> {
  const started = Date.now();
  return new Promise<T>((resolve, reject) => {
    const tick = (): void => {
      const result = fn();
      if (result !== undefined) {
        resolve(result);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function settleWatcher(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

afterEach(async () => {
  const dirs = cleanupDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createTuiConfigWatcher", () => {
  test("broadcasts ConfigChanged when aliases.yaml changes within 500ms", async () => {
    const { homeDir, projectRoot } = await makeFixture();
    const aliasPath = join(homeDir, ".grove", "aliases.yaml");
    await writeFile(aliasPath, "ops: agents\n", "utf8");

    const watcher = createTuiConfigWatcher({ homeDir, projectRoot, debounceMs: 20 });
    const events: string[] = [];
    const unsubscribe = watcher.subscribe((event) => {
      if (event.type === "ConfigChanged" && event.changed === "aliases") {
        events.push(event.config.aliases.get("new")?.value ?? "");
      }
    });

    await watcher.start();
    await settleWatcher();
    await writeFile(aliasPath, "ops: agents\nnew: dag\n", "utf8");

    await waitFor(() => (events.includes("dag") ? true : undefined));
    expect(watcher.current().aliases.get("new")?.value).toBe("dag");

    unsubscribe();
    await watcher.stop();
  });

  test("invalid aliases.yaml emits ConfigError and keeps the last good aliases", async () => {
    const { homeDir, projectRoot } = await makeFixture();
    const aliasPath = join(homeDir, ".grove", "aliases.yaml");
    await writeFile(aliasPath, "ops: agents\n", "utf8");

    const watcher = createTuiConfigWatcher({ homeDir, projectRoot, debounceMs: 20 });
    const errors: string[] = [];
    watcher.subscribe((event) => {
      if (event.type === "ConfigError" && event.changed === "aliases") {
        errors.push(event.message);
      }
    });

    await watcher.start();
    await settleWatcher();
    expect(watcher.current().aliases.get("ops")?.value).toBe("agents");

    await writeFile(aliasPath, "not: : valid:: yaml: [", "utf8");

    await waitFor(() => errors[0]);
    expect(errors[0]).toContain("aliases.yaml");
    expect(watcher.current().aliases.get("ops")?.value).toBe("agents");

    await watcher.stop();
  });

  test("invalid aliases.yaml at startup emits ConfigError and keeps defaults", async () => {
    const { homeDir, projectRoot } = await makeFixture();
    const aliasPath = join(homeDir, ".grove", "aliases.yaml");
    await writeFile(aliasPath, "not: : valid:: yaml: [", "utf8");

    const watcher = createTuiConfigWatcher({ homeDir, projectRoot, debounceMs: 20 });
    const errors: string[] = [];
    watcher.subscribe((event) => {
      if (event.type === "ConfigError" && event.changed === "aliases") {
        errors.push(event.message);
      }
    });

    await watcher.start();

    expect(errors[0]).toContain("aliases.yaml");
    expect(watcher.current().aliases.get("a")?.value).toBe("agents");

    await watcher.stop();
  });

  test("broadcasts hotkeys.yaml changes as remappable key overrides", async () => {
    const { homeDir, projectRoot } = await makeFixture();
    const hotkeysPath = join(homeDir, ".grove", "hotkeys.yaml");
    await writeFile(hotkeysPath, "refresh: F5\n", "utf8");

    const watcher = createTuiConfigWatcher({ homeDir, projectRoot, debounceMs: 20 });
    const values: string[] = [];
    watcher.subscribe((event) => {
      if (event.type === "ConfigChanged" && event.changed === "hotkeys") {
        values.push(event.config.hotkeys.quit ?? "");
      }
    });

    await watcher.start();
    await settleWatcher();
    await writeFile(hotkeysPath, "refresh: F5\nquit: Q\n", "utf8");

    await waitFor(() => (values.includes("Q") ? true : undefined));
    expect(watcher.current().hotkeys.quit).toBe("Q");

    await watcher.stop();
  });

  test("broadcasts parameterized panel hotkeys", async () => {
    const { homeDir, projectRoot } = await makeFixture();
    const hotkeysPath = join(homeDir, ".grove", "hotkeys.yaml");
    await writeFile(hotkeysPath, '"toggle_panel:terminal": Space p x\n', "utf8");

    const watcher = createTuiConfigWatcher({ homeDir, projectRoot, debounceMs: 20 });
    await watcher.start();
    await settleWatcher();

    expect(watcher.current().hotkeys["toggle_panel:terminal"]).toBe("Space p x");

    await watcher.stop();
  });

  test("broadcasts theme.yaml changes as theme token overrides", async () => {
    const { homeDir, projectRoot } = await makeFixture();
    const themePath = join(homeDir, ".grove", "theme.yaml");
    await writeFile(themePath, "focus: '#00ffff'\n", "utf8");

    const watcher = createTuiConfigWatcher({ homeDir, projectRoot, debounceMs: 20 });
    const values: string[] = [];
    watcher.subscribe((event) => {
      if (event.type === "ConfigChanged" && event.changed === "theme") {
        values.push(event.config.theme.error ?? "");
      }
    });

    await watcher.start();
    await settleWatcher();
    await writeFile(themePath, "focus: '#00ffff'\nerror: red\n", "utf8");

    await waitFor(() => (values.includes("red") ? true : undefined));
    expect(watcher.current().theme.error).toBe("red");

    await watcher.stop();
  });
});
