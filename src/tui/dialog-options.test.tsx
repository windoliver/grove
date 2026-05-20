import { describe, expect, test } from "bun:test";
import { choiceDialogOptions, type DialogId, textPromptDialogOptions } from "./dialog-options.js";

describe("dialog option builders", () => {
  test("textPromptDialogOptions returns runtime-compatible content options", () => {
    const options = textPromptDialogOptions({
      title: "Handoff cancel",
      message: "Reason",
      defaultValue: "cancel",
    });

    expect(typeof options.content).toBe("function");
    expect(options.fallback).toBeUndefined();

    const dialogId: DialogId = 1;
    const element = options.content({
      dialogId,
      resolve: () => {
        /* no-op */
      },
      dismiss: () => {
        /* no-op */
      },
    });

    expect(element).toBeDefined();
  });

  test("choiceDialogOptions returns runtime-compatible typed choices", () => {
    const options = choiceDialogOptions({
      title: "Reroute Handoff",
      message: "Target role",
      choices: ["coder", "reviewer"] as const,
    });

    expect(typeof options.content).toBe("function");
    expect(options.fallback).toBeUndefined();

    const dialogId: DialogId = "handoff-choice";
    const element = options.content({
      dialogId,
      resolve: () => {
        /* no-op */
      },
      dismiss: () => {
        /* no-op */
      },
    });

    expect(element).toBeDefined();
  });
});
