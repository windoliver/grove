import path from "node:path";

const decoder = new TextDecoder();

function readText(bytes) {
  return decoder.decode(bytes).trim();
}

function run(command) {
  const result = Bun.spawnSync(command, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  return {
    command,
    exitCode: result.exitCode,
    stdout: readText(result.stdout),
    stderr: readText(result.stderr),
  };
}

function logCommandFailure(result) {
  const commandText = result.command.join(" ");
  console.error(`[grove] Command failed: ${commandText}`);

  if (result.stdout.length > 0) {
    console.error(result.stdout);
  }

  if (result.stderr.length > 0) {
    console.error(result.stderr);
  }
}

function resolveFromRepoRoot(repoRoot, targetPath) {
  if (path.isAbsolute(targetPath)) {
    return path.normalize(targetPath);
  }

  return path.resolve(repoRoot, targetPath);
}

function resolveLefthookExecutable(repoRoot) {
  const executable = Bun.which("lefthook");
  if (executable !== null) {
    return executable;
  }

  const binaryName = process.platform === "win32" ? "lefthook.cmd" : "lefthook";
  return path.join(repoRoot, "node_modules", ".bin", binaryName);
}

const repoRootResult = run(["git", "rev-parse", "--show-toplevel"]);
if (repoRootResult.exitCode !== 0) {
  console.warn("[grove] Skipping Git hook installation outside a Git worktree.");
  process.exit(0);
}

const gitCommonDirResult = run(["git", "rev-parse", "--git-common-dir"]);
if (gitCommonDirResult.exitCode !== 0) {
  logCommandFailure(gitCommonDirResult);
  process.exit(gitCommonDirResult.exitCode);
}

const configuredHooksPathResult = run([
  "git",
  "config",
  "--local",
  "--get",
  "core.hooksPath",
]);

const repoRoot = repoRootResult.stdout;
const lefthookExecutable = resolveLefthookExecutable(repoRoot);
const defaultHooksPath = resolveFromRepoRoot(
  repoRoot,
  path.join(gitCommonDirResult.stdout, "hooks"),
);

const hasConfiguredHooksPath = configuredHooksPathResult.exitCode === 0;
if (hasConfiguredHooksPath) {
  const configuredHooksPath = resolveFromRepoRoot(
    repoRoot,
    configuredHooksPathResult.stdout,
  );

  if (configuredHooksPath !== defaultHooksPath) {
    console.warn(
      `[grove] Skipping Lefthook install because core.hooksPath is set to "${configuredHooksPathResult.stdout}".`,
    );
    console.warn(
      '[grove] Run "lefthook install --force" to install Grove hooks there, or "lefthook install --reset-hooks-path" to reset the config.',
    );
    process.exit(0);
  }
}

const lefthookCommand = hasConfiguredHooksPath
  ? [lefthookExecutable, "install", "--force"]
  : [lefthookExecutable, "install"];
const lefthookResult = run(lefthookCommand);

if (lefthookResult.exitCode !== 0) {
  logCommandFailure(lefthookResult);
  process.exit(lefthookResult.exitCode);
}

if (lefthookResult.stdout.length > 0) {
  console.log(lefthookResult.stdout);
}

if (lefthookResult.stderr.length > 0) {
  console.error(lefthookResult.stderr);
}
