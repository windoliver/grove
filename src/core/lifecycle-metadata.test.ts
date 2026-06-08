import { describe, expect, test } from "bun:test";
import {
  appendDeletionAudit,
  type CascadePolicy,
  DEFAULT_SESSION_FINALIZERS,
  Finalizer,
  KindFinalizer,
  type OwnerRef,
  ownerRefsEqual,
  PropagationFinalizer,
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

  test("OwnerRef carries an optional controller flag without affecting identity", () => {
    const a: OwnerRef = { kind: "taskGroup", id: "tg-1", uid: "uid-1", controller: true };
    const b: OwnerRef = { kind: "taskGroup", id: "tg-1", uid: "uid-1" };
    // controller is metadata, not identity — equality is UID-based.
    expect(ownerRefsEqual(a, b)).toBe(true);
  });

  test("new owner kinds are assignable", () => {
    const refs: OwnerRef[] = [
      { kind: "session", id: "s", uid: "u" },
      { kind: "claim", id: "c", uid: "u" },
      { kind: "taskGroup", id: "tg", uid: "u" },
      { kind: "agentTask", id: "at", uid: "u" },
    ];
    expect(refs).toHaveLength(4);
  });

  test("finalizer namespaces are stable", () => {
    expect(KindFinalizer.PendingReview).toBe("grove.dev/pending-review");
    expect(KindFinalizer.PendingMerge).toBe("grove.dev/pending-merge");
    expect(PropagationFinalizer.Foreground).toBe("grove.dev/foreground-deletion");
    expect(PropagationFinalizer.Orphan).toBe("grove.dev/orphan");
  });

  test("cascade policy values", () => {
    const policies: CascadePolicy[] = ["Foreground", "Background", "Orphan"];
    expect(policies).toContain("Background");
  });
});
