/**
 * Tests for ConfirmPopDialog: visibility, content rendering.
 */

import { describe, expect, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { ConfirmPopDialog } from "./confirm-pop-dialog.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ConfirmPopDialog", () => {
  test("renders null when visible=false", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ConfirmPopDialog
          visible={false}
          onConfirm={() => {
            // noop for test
          }}
          onCancel={() => {
            // noop for test
          }}
        />,
      );
    });

    expect(renderer.toJSON()).toBe(null);
    renderer.unmount();
  });

  test("renders title when visible=true", () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ConfirmPopDialog
          visible={true}
          onConfirm={() => {
            // noop for test
          }}
          onCancel={() => {
            // noop for test
          }}
        />,
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
        <ConfirmPopDialog
          visible={true}
          onConfirm={() => {
            // noop for test
          }}
          onCancel={() => {
            // noop for test
          }}
        />,
      );
    });

    const flat = JSON.stringify(renderer.toJSON());
    expect(flat).toContain("[y]");
    expect(flat).toContain("[n]");

    renderer.unmount();
  });
});
