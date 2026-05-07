import { describe, expect, test } from "bun:test";
import {
  appendDeletionAudit,
  DEFAULT_SESSION_FINALIZERS,
  Finalizer,
  ownerRefsEqual,
} from "./lifecycle-metadata.js";

describe("lifecycle metadata", () => {
  test("DEFAULT_SESSION_FINALIZERS uses the stable cleanup order", () => {
    expect(DEFAULT_SESSION_FINALIZERS).toEqual([
      Finalizer.ReleaseSlots,
      Finalizer.DrainContribs,
      Finalizer.CloseRuntime,
    ]);
  });

  test("ownerRefsEqual compares kind, id, and uid", () => {
    const a = { kind: "session" as const, id: "s1", uid: "uid-1" };
    expect(ownerRefsEqual(a, { kind: "session", id: "s1", uid: "uid-1" })).toBe(true);
    expect(ownerRefsEqual(a, { kind: "session", id: "s1", uid: "uid-2" })).toBe(false);
    expect(ownerRefsEqual(a, undefined)).toBe(false);
  });

  test("appendDeletionAudit appends a force-delete warning event", () => {
    const event = appendDeletionAudit(undefined, {
      at: "2026-05-07T00:00:00.000Z",
      actor: "cli",
      warning: "force delete skipped finalizer waits for session s1",
    });

    expect(event).toEqual([
      {
        at: "2026-05-07T00:00:00.000Z",
        actor: "cli",
        force: true,
        warning: "force delete skipped finalizer waits for session s1",
      },
    ]);
  });
});
