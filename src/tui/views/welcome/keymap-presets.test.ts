import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyKeymapPresetToFile,
  loadKeymapPreset,
  type KeymapPresetName,
} from "./keymap-presets.js";

describe("loadKeymapPreset", () => {
  test("loads vim preset", async () => {
    const p = await loadKeymapPreset("vim");
    expect(p.keymap.quit).toBe("q");
    expect(p.keymap.search_start).toBe("/");
  });

  test("loads emacs preset", async () => {
    const p = await loadKeymapPreset("emacs");
    expect(p.keymap.help).toBe("C-h");
  });
});

describe("applyKeymapPresetToFile", () => {
  test("writes a fresh config.json when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    await applyKeymapPresetToFile("vim" as KeymapPresetName, target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymap.quit).toBe("q");
    expect(raw.theme ?? {}).toEqual({});
  });

  test("merges keymap block into existing config without touching theme", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    writeFileSync(
      target,
      JSON.stringify({
        theme: { text: "#FFFFFF" },
        keymap: { approve: "A" },
      }),
    );
    await applyKeymapPresetToFile("emacs", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.theme.text).toBe("#FFFFFF");
    expect(raw.keymap.approve).toBe("A"); // untouched
    expect(raw.keymap.help).toBe("C-h"); // from preset
  });

  test("overwrites preset keys on re-apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    await applyKeymapPresetToFile("vim", target);
    await applyKeymapPresetToFile("emacs", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymap.quit).toBe("C-x C-c");
  });

  test("corrupted existing config is treated as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    writeFileSync(target, "{ not valid json");
    await applyKeymapPresetToFile("vim", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymap.quit).toBe("q");
  });
});
