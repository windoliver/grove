import { expect, test } from "bun:test";
import { parseSessionId } from "./session-id.js";
import { SubprocessRuntime } from "./subprocess-runtime.js";

test("SubprocessRuntime.send returns error turn when the child has already exited", async () => {
  const rt = new SubprocessRuntime();
  const session = await rt.spawn("smoke", { role: "smoke", command: "true", cwd: "/tmp" });

  // `true` exits immediately — wait for proc.exited to propagate.
  await new Promise((r) => setTimeout(r, 100));

  const turn = await rt.send(session, "hello");
  const result = await turn.result;
  expect(result.stopReason).toBe("error");
  expect(result.error?.code).toBe("child_exited");
});

test("SubprocessRuntime.send returns error turn when session id is unknown", async () => {
  const rt = new SubprocessRuntime();
  const turn = await rt.send({ id: "never-spawned", role: "smoke", status: "running" }, "hello");
  const result = await turn.result;
  expect(result.stopReason).toBe("error");
  expect(result.error?.code).toBe("no_session");
});

test("SubprocessRuntime.send returns end_turn for a live child", async () => {
  const rt = new SubprocessRuntime();
  // `cat` reads stdin forever — stays alive until we close.
  const session = await rt.spawn("smoke", { role: "smoke", command: "cat", cwd: "/tmp" });
  try {
    const turn = await rt.send(session, "hello");
    const result = await turn.result;
    expect(result.stopReason).toBe("end_turn");
  } finally {
    await rt.close(session);
  }
});

test("SubprocessRuntime.spawn uses canonical session IDs", async () => {
  const rt = new SubprocessRuntime();
  const session = await rt.spawn("smoke", { role: "smoke", command: "cat", cwd: "/tmp" });
  try {
    const parsed = parseSessionId(session.id);
    expect(parsed).not.toBeNull();
    expect(parsed?.role).toBe("smoke");
  } finally {
    await rt.close(session);
  }
});

test("SubprocessRuntime.spawn preserves quoted command arguments", async () => {
  const rt = new SubprocessRuntime();
  const session = await rt.spawn("quoted", {
    role: "quoted",
    // Needs proper quote-aware argv splitting so the whole script stays one arg.
    command: 'bun -e "setInterval(() => {}, 1000)"',
    cwd: "/tmp",
  });
  try {
    // Give the child a moment to fail fast if argv parsing was broken.
    await new Promise((r) => setTimeout(r, 50));
    const turn = await rt.send(session, "ping");
    const result = await turn.result;
    expect(result.stopReason).toBe("end_turn");
  } finally {
    await rt.close(session);
  }
});
