import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyKeymapPresetToFile,
  type KeymapPresetName,
  loadKeymapPreset,
} from "./keymap-presets.js";

describe("loadKeymapPreset", () => {
  test("loads default preset choice", async () => {
    const p = await loadKeymapPreset("default");
    expect(p.keymapPreset).toBe("default");
    expect(p.keymap).toEqual({});
  });

  test("loads power-user preset choice", async () => {
    const p = await loadKeymapPreset("power-user");
    expect(p.keymapPreset).toBe("power-user");
    expect(p.keymap).toEqual({});
  });
});

describe("applyKeymapPresetToFile", () => {
  test("default preset does not create a config.json when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    await applyKeymapPresetToFile("default" as KeymapPresetName, target);
    expect(existsSync(target)).toBe(false);
  });

  test("power-user writes a fresh config.json when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    await applyKeymapPresetToFile("power-user" as KeymapPresetName, target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymapPreset).toBe("power-user");
    expect(raw.keymap ?? {}).toEqual({});
    expect(raw.theme ?? {}).toEqual({});
  });

  test("writes default keymapPreset when config already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    writeFileSync(target, JSON.stringify({ theme: { text: "#FFFFFF" }, keymap: { approve: "A" } }));
    await applyKeymapPresetToFile("default", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.theme.text).toBe("#FFFFFF");
    expect(raw.keymap.approve).toBe("A");
    expect(raw.keymapPreset).toBe("default");
  });

  test("merges preset choice into existing config without touching theme or keymap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    writeFileSync(
      target,
      JSON.stringify({
        theme: { text: "#FFFFFF" },
        keymap: { approve: "A" },
      }),
    );
    await applyKeymapPresetToFile("power-user", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.theme.text).toBe("#FFFFFF");
    expect(raw.keymap.approve).toBe("A");
    expect(raw.keymapPreset).toBe("power-user");
  });

  test("overwrites keymapPreset on re-apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    await applyKeymapPresetToFile("power-user", target);
    await applyKeymapPresetToFile("default", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymapPreset).toBe("default");
  });

  test("corrupted existing config is treated as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grove-keymap-"));
    const target = join(dir, "config.json");
    writeFileSync(target, "{ not valid json");
    await applyKeymapPresetToFile("power-user", target);
    const raw = JSON.parse(readFileSync(target, "utf-8"));
    expect(raw.keymapPreset).toBe("power-user");
  });
});
