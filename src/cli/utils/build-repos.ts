/**
 * Build the session-level `repos` array from CLI `--repo` flag values.
 *
 * Rules:
 * - Zero `--repo` values: default to a local RepoRef at `cwd`. Require that
 *   `cwd` is a git repo; throw otherwise with a message pointing at `--repo`.
 * - Exactly one `--repo` value: parse it as local (leading `/` or `.`) or URL.
 * - Two or more `--repo` values: throw — multi-repo sessions land in a
 *   later sub-spec.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoRef } from "../../core/repo-ref.js";

export interface BuildReposInputs {
  readonly rawRepo: readonly string[];
  readonly cwd: string;
  readonly isGitRepo?: (path: string) => boolean;
}

export function buildRepos(inputs: BuildReposInputs): readonly RepoRef[] {
  const { rawRepo, cwd } = inputs;
  const isGitRepo = inputs.isGitRepo ?? ((p: string) => existsSync(join(p, ".git")));

  if (rawRepo.length > 1) {
    throw new Error(
      "multi-repo sessions are not yet supported (see sub-spec for #202). Pass at most one --repo.",
    );
  }

  if (rawRepo.length === 1) {
    const raw = rawRepo[0]!;
    if (raw.startsWith("/") || raw.startsWith(".")) {
      return [{ kind: "local", path: raw }];
    }
    return [{ kind: "url", url: raw }];
  }

  if (!isGitRepo(cwd)) {
    throw new Error("run grove from inside a git repo, or pass --repo <url>");
  }
  return [{ kind: "local", path: cwd }];
}
