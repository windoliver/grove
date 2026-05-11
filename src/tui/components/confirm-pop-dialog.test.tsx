/**
 * Tests for ConfirmPopDialog: visibility, content rendering.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ConfirmPopDialog } from "./confirm-pop-dialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = (): void => {
  /* noop for test */
};

describe("ConfirmPopDialog", () => {
  test("renders null when visible=false", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        (
          <ConfirmPopDialog visible={false} onConfirm={noop} onCancel={noop} />
        ) as React.ReactElement,
      );
    });

    expect(renderer.toJSON()).toBe(null);
    renderer.unmount();
  });

  test("renders title when visible=true", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        (
          <ConfirmPopDialog visible={true} onConfirm={noop} onCancel={noop} />
        ) as React.ReactElement,
      );
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("Discard unsaved changes?");

    renderer.unmount();
  });

  test("renders hint markers when visible=true", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        (
          <ConfirmPopDialog visible={true} onConfirm={noop} onCancel={noop} />
        ) as React.ReactElement,
      );
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("[y]");
    expect(flat).toContain("[n]");

    renderer.unmount();
  });
});
