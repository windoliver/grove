import { describe, expect, test } from "bun:test";

import {
  buildMessageContext,
  buildPlanContext,
  isEphemeralMessageContext,
  type PlanTask,
  parseMessageContext,
  parsePlanContext,
} from "./context-schemas.js";

// ---------------------------------------------------------------------------
// PlanContext
// ---------------------------------------------------------------------------

describe("buildPlanContext + parsePlanContext", () => {
  const tasks: readonly PlanTask[] = [
    { id: "t1", title: "Design API", status: "todo" },
    { id: "t2", title: "Write tests", status: "in_progress", assignee: "@alice" },
    { id: "t3", title: "Ship", status: "done" },
  ];

  test("round-trips title and tasks", () => {
    const ctx = buildPlanContext({ title: "Phase 1", tasks });
    expect(ctx.plan_title).toBe("Phase 1");
    const parsed = parsePlanContext(ctx);
    expect(parsed?.plan_title).toBe("Phase 1");
    expect(parsed?.tasks).toEqual([...tasks]);
  });

  test("parse returns undefined when context is missing", () => {
    expect(parsePlanContext(undefined)).toBeUndefined();
  });

  test("parse returns undefined when plan_title is missing", () => {
    expect(parsePlanContext({ tasks: tasks as unknown as never })).toBeUndefined();
  });

  test("parse returns undefined when tasks is missing", () => {
    expect(parsePlanContext({ plan_title: "Phase 1" })).toBeUndefined();
  });

  test("parse returns undefined when task status is invalid", () => {
    const bad = {
      plan_title: "Phase 1",
      tasks: [{ id: "t1", title: "Bad", status: "wibble" }],
    };
    expect(parsePlanContext(bad as never)).toBeUndefined();
  });

  test("parse returns undefined when task missing required fields", () => {
    const bad = { plan_title: "Phase 1", tasks: [{ id: "t1" }] };
    expect(parsePlanContext(bad as never)).toBeUndefined();
  });

  test("parse accepts task without assignee", () => {
    const ctx = buildPlanContext({
      title: "P",
      tasks: [{ id: "t1", title: "Solo", status: "todo" }],
    });
    const parsed = parsePlanContext(ctx);
    expect(parsed?.tasks[0]?.assignee).toBeUndefined();
  });

  test("parse rejects context with non-array tasks", () => {
    expect(parsePlanContext({ plan_title: "P", tasks: "not-an-array" as never })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MessageContext
// ---------------------------------------------------------------------------

describe("buildMessageContext + parseMessageContext", () => {
  test("round-trips recipients and body", () => {
    const ctx = buildMessageContext({ recipients: ["@bob"], body: "hello" });
    expect(ctx.ephemeral).toBe(true);
    expect(ctx.recipients).toEqual(["@bob"]);
    expect(ctx.message_body).toBe("hello");
    const parsed = parseMessageContext(ctx);
    expect(parsed?.recipients).toEqual(["@bob"]);
    expect(parsed?.message_body).toBe("hello");
  });

  test("multi-recipient round trip", () => {
    const ctx = buildMessageContext({ recipients: ["@bob", "@alice", "@all"], body: "hi" });
    const parsed = parseMessageContext(ctx);
    expect(parsed?.recipients).toEqual(["@bob", "@alice", "@all"]);
  });

  test("parse returns undefined when context is missing", () => {
    expect(parseMessageContext(undefined)).toBeUndefined();
  });

  test("parse returns undefined when ephemeral is false", () => {
    expect(
      parseMessageContext({
        ephemeral: false,
        recipients: ["@bob"],
        message_body: "hi",
      } as never),
    ).toBeUndefined();
  });

  test("parse returns undefined when ephemeral is missing", () => {
    expect(parseMessageContext({ recipients: ["@bob"], message_body: "hi" })).toBeUndefined();
  });

  test("parse returns undefined when recipients is empty", () => {
    expect(
      parseMessageContext({ ephemeral: true, recipients: [], message_body: "hi" }),
    ).toBeUndefined();
  });

  test("parse returns undefined when message_body is missing", () => {
    expect(parseMessageContext({ ephemeral: true, recipients: ["@bob"] })).toBeUndefined();
  });

  test("parse rejects unrelated context that happens to have similar keys", () => {
    expect(
      parseMessageContext({ ephemeral: 1, recipients: ["@bob"], message_body: "hi" } as never),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isEphemeralMessageContext
// ---------------------------------------------------------------------------

describe("isEphemeralMessageContext", () => {
  test("true when context.ephemeral === true", () => {
    expect(isEphemeralMessageContext({ ephemeral: true })).toBe(true);
  });

  test("false when context is undefined", () => {
    expect(isEphemeralMessageContext(undefined)).toBe(false);
  });

  test("false when ephemeral is missing", () => {
    expect(isEphemeralMessageContext({ recipients: ["@bob"] })).toBe(false);
  });

  test("false when ephemeral is the literal false", () => {
    expect(isEphemeralMessageContext({ ephemeral: false })).toBe(false);
  });

  test("false when ephemeral is a truthy non-true value", () => {
    expect(isEphemeralMessageContext({ ephemeral: 1 as never })).toBe(false);
    expect(isEphemeralMessageContext({ ephemeral: "true" as never })).toBe(false);
  });
});
