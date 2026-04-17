import { expect, test } from "bun:test";
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
