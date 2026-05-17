import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface StartReviewLoopInputs {
  readonly goal: string;
  readonly coderRuntime?: string | undefined; // default "codex"
  readonly reviewerRuntime?: string | undefined; // default "claude"
  readonly groveUrl: string;
  readonly token: string;
  readonly groveDir: string;
  readonly now?: (() => Date) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly mkdirImpl?: ((path: string) => void) | undefined;
}

export interface StartReviewLoopResult {
  readonly worktree: string;
  readonly coderId: string;
  readonly reviewerId: string;
}

export async function startReviewLoop(
  inputs: StartReviewLoopInputs,
): Promise<StartReviewLoopResult> {
  if (inputs.goal.length === 0) throw new Error("goal must not be empty");
  if (inputs.groveUrl.length === 0) throw new Error("groveUrl must not be empty");
  if (inputs.token.length === 0) throw new Error("token must not be empty");

  const now = (inputs.now ?? (() => new Date()))();
  const isoStamp = now.toISOString();
  const safeStamp = isoStamp.replace(/[:.]/g, "-");

  const worktree = join(inputs.groveDir, "workspaces", `review-loop-${safeStamp}`);
  (inputs.mkdirImpl ?? ((p) => mkdirSync(p, { recursive: true })))(worktree);

  const coderId = `review-loop-${safeStamp}-coder`;
  const reviewerId = `review-loop-${safeStamp}-reviewer`;

  const coderRuntime = inputs.coderRuntime ?? "codex";
  const reviewerRuntime = inputs.reviewerRuntime ?? "claude";

  await putTask(
    inputs.groveUrl,
    inputs.token,
    coderId,
    {
      worktree,
      runtime: coderRuntime,
      role: "coder",
      prompt: inputs.goal,
      dependsOn: [],
    },
    inputs.fetchImpl,
  );

  try {
    await putTask(
      inputs.groveUrl,
      inputs.token,
      reviewerId,
      {
        worktree,
        runtime: reviewerRuntime,
        role: "reviewer",
        prompt: `Review the work completed for: ${inputs.goal}`,
        dependsOn: [coderId],
      },
      inputs.fetchImpl,
    );
  } catch (err) {
    // Best-effort cleanup of coder if reviewer creation fails.
    await deleteTask(inputs.groveUrl, inputs.token, coderId, inputs.fetchImpl).catch(
      () => undefined,
    );
    throw err;
  }

  return { worktree, coderId, reviewerId };
}

interface TaskBody {
  readonly worktree: string;
  readonly runtime: string;
  readonly role: string;
  readonly prompt: string;
  readonly dependsOn: readonly string[];
}

async function putTask(
  baseUrl: string,
  token: string,
  id: string,
  body: TaskBody,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const fetcher = fetchImpl ?? fetch;
  const url = `${baseUrl}/api/agent-tasks/${encodeURIComponent(id)}`;
  const res = await fetcher(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "If-Match": "*",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PUT /api/agent-tasks/${id} failed: ${res.status} ${text}`);
  }
}

async function deleteTask(
  baseUrl: string,
  token: string,
  id: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const fetcher = fetchImpl ?? fetch;
  await fetcher(`${baseUrl}/api/agent-tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}
