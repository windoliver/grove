import { describe, expect, test } from "bun:test";
import { startReviewLoop } from "./start.js";

describe("startReviewLoop", () => {
  test("posts coder + reviewer with dependsOn chain", async () => {
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response("{}", { status: 201 });
    };
    const mkdirCalls: string[] = [];
    const result = await startReviewLoop({
      goal: "Implement feature X",
      groveUrl: "http://localhost:4515",
      token: "tok",
      groveDir: "/tmp/grove",
      now: () => new Date("2026-05-16T10:00:00.000Z"),
      fetchImpl: fakeFetch,
      mkdirImpl: (p) => mkdirCalls.push(p),
    });

    expect(result.worktree).toBe("/tmp/grove/workspaces/review-loop-2026-05-16T10-00-00-000Z");
    expect(result.coderId).toBe("review-loop-2026-05-16T10-00-00-000Z-coder");
    expect(result.reviewerId).toBe("review-loop-2026-05-16T10-00-00-000Z-reviewer");
    expect(mkdirCalls).toEqual([result.worktree]);
    expect(calls).toHaveLength(2);

    const coderBody = JSON.parse(calls[0]!.body!);
    expect(coderBody.runtime).toBe("codex");
    expect(coderBody.role).toBe("coder");
    expect(coderBody.dependsOn).toEqual([]);
    expect(coderBody.worktree).toBe(result.worktree);
    expect(coderBody.prompt).toBe("Implement feature X");

    const reviewerBody = JSON.parse(calls[1]!.body!);
    expect(reviewerBody.runtime).toBe("claude");
    expect(reviewerBody.role).toBe("reviewer");
    expect(reviewerBody.dependsOn).toEqual([result.coderId]);
    expect(reviewerBody.worktree).toBe(result.worktree);
    expect(reviewerBody.prompt).toContain("Implement feature X");
  });

  test("honors runtime overrides", async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(init?.body as string);
      calls.push(body.runtime);
      return new Response("{}", { status: 201 });
    };
    await startReviewLoop({
      goal: "x",
      groveUrl: "http://x",
      token: "t",
      groveDir: "/tmp",
      coderRuntime: "codex-cli",
      reviewerRuntime: "claude-code",
      fetchImpl: fakeFetch,
      mkdirImpl: () => {},
    });
    expect(calls).toEqual(["codex-cli", "claude-code"]);
  });

  test("rejects empty goal / url / token", async () => {
    const noop: typeof fetch = async () => new Response("{}", { status: 201 });
    await expect(
      startReviewLoop({
        goal: "",
        groveUrl: "x",
        token: "y",
        groveDir: "/",
        fetchImpl: noop,
        mkdirImpl: () => {},
      }),
    ).rejects.toThrow(/goal/);
    await expect(
      startReviewLoop({
        goal: "g",
        groveUrl: "",
        token: "y",
        groveDir: "/",
        fetchImpl: noop,
        mkdirImpl: () => {},
      }),
    ).rejects.toThrow(/groveUrl/);
    await expect(
      startReviewLoop({
        goal: "g",
        groveUrl: "x",
        token: "",
        groveDir: "/",
        fetchImpl: noop,
        mkdirImpl: () => {},
      }),
    ).rejects.toThrow(/token/);
  });

  test("cleans up coder when reviewer PUT fails", async () => {
    let putCount = 0;
    let deleteCount = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        putCount += 1;
        if (putCount === 2) return new Response("nope", { status: 500 });
        return new Response("{}", { status: 201 });
      }
      if (method === "DELETE") {
        deleteCount += 1;
        return new Response("{}", { status: 204 });
      }
      return new Response("", { status: 404 });
    };
    await expect(
      startReviewLoop({
        goal: "g",
        groveUrl: "http://x",
        token: "t",
        groveDir: "/tmp",
        fetchImpl: fakeFetch,
        mkdirImpl: () => {},
      }),
    ).rejects.toThrow(/500/);
    expect(deleteCount).toBe(1);
  });

  test("non-2xx PUT for coder throws and skips reviewer", async () => {
    let putCount = 0;
    const fakeFetch: typeof fetch = async () => {
      putCount += 1;
      return new Response("server down", { status: 503 });
    };
    await expect(
      startReviewLoop({
        goal: "g",
        groveUrl: "http://x",
        token: "t",
        groveDir: "/tmp",
        fetchImpl: fakeFetch,
        mkdirImpl: () => {},
      }),
    ).rejects.toThrow(/503/);
    expect(putCount).toBe(1);
  });
});
