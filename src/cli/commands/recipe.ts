import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { JsonValue } from "../../core/models.js";
import {
  bindRecipeParameters,
  computeBoundRecipeDigest,
  computeRecipeDigest,
  discoverRecipes,
  materializeRecipeContract,
  parseGroveRecipe,
} from "../../core/recipe.js";
import { UsageError } from "../errors.js";

type RecipeCommand =
  | { readonly command: "validate"; readonly path: string; readonly json: boolean }
  | { readonly command: "list"; readonly dir?: string | undefined; readonly json: boolean }
  | {
      readonly command: "run";
      readonly path: string;
      readonly params: Readonly<Record<string, string>>;
      readonly dryRun: boolean;
      readonly json: boolean;
      readonly goal?: string | undefined;
      readonly repos: readonly string[];
    };

interface RecipeDeps {
  readonly cwd: string;
  readonly writer: (line: string) => void;
  readonly launch?: typeof import("../utils/launch-session.js").launchGoalSession | undefined;
}

export function parseRecipeArgs(argv: readonly string[]): RecipeCommand {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (subcommand === "validate") {
    const parsed = parseArgs({
      args: [...rest],
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
    const path = parsed.positionals[0];
    if (path === undefined) throw new UsageError("recipe validate requires <path>");
    if (parsed.positionals.length > 1) throw new UsageError("recipe validate accepts one <path>");
    return { command: "validate", path, json: parsed.values.json ?? false };
  }
  if (subcommand === "list") {
    const parsed = parseArgs({
      args: [...rest],
      options: { dir: { type: "string" }, json: { type: "boolean", default: false } },
      allowPositionals: false,
      strict: true,
    });
    return { command: "list", dir: parsed.values.dir, json: parsed.values.json ?? false };
  }
  if (subcommand === "run") {
    const parsed = parseArgs({
      args: [...rest],
      options: {
        param: { type: "string", multiple: true },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        repo: { type: "string", multiple: true },
        goal: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    const path = parsed.positionals[0];
    if (path === undefined) throw new UsageError("recipe run requires <path>");
    if (parsed.positionals.length > 1) throw new UsageError("recipe run accepts one <path>");
    return {
      command: "run",
      path,
      params: parseParamFlags(parsed.values.param ?? []),
      dryRun: parsed.values["dry-run"] ?? false,
      json: parsed.values.json ?? false,
      ...(parsed.values.goal !== undefined && { goal: parsed.values.goal }),
      repos: parsed.values.repo ?? [],
    };
  }
  throw new UsageError("recipe requires subcommand: validate, list, or run");
}

export async function handleRecipe(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<void> {
  await runRecipe(parseRecipeArgs(args), { cwd, writer: console.log });
}

export async function runRecipe(command: RecipeCommand, deps: RecipeDeps): Promise<void> {
  if (command.command === "validate") {
    const content = await readFile(resolveRecipePath(command.path, deps.cwd), "utf-8");
    const recipe = parseGroveRecipe(content);
    const digest = computeRecipeDigest(recipe);
    if (command.json) {
      deps.writer(
        JSON.stringify(
          { valid: true, name: recipe.name, version: recipe.version, digest },
          null,
          2,
        ),
      );
      return;
    }
    deps.writer(`Valid recipe: ${recipe.name}@${recipe.version}`);
    deps.writer(`Digest: ${digest}`);
    return;
  }
  if (command.command === "list") {
    const entries = await discoverRecipes({ cwd: command.dir ?? deps.cwd });
    if (command.json) {
      deps.writer(JSON.stringify(entries, null, 2));
      return;
    }
    if (entries.length === 0) {
      deps.writer("No recipes found.");
      return;
    }
    deps.writer(
      entries
        .map(
          (entry) => `${entry.recipe.name}@${entry.recipe.version} ${entry.source} ${entry.path}`,
        )
        .join("\n"),
    );
    return;
  }
  const content = await readFile(resolveRecipePath(command.path, deps.cwd), "utf-8");
  const recipe = parseGroveRecipe(content);
  const bound = bindRecipeParameters(recipe, command.params);
  const materialized = materializeRecipeContract(bound);

  if (command.dryRun) {
    const payload = {
      recipe: { name: recipe.name, version: recipe.version },
      recipeDigest: bound.recipeDigest,
      boundParameterDigest: computeBoundRecipeDigest(bound),
      parameters: bound.parameters,
      renderedInstructions: materialized.renderedInstructions,
      extensions: materialized.extensions,
      subRecipes: materialized.subRecipes,
      runPolicy: materialized.runPolicy,
      contract: materialized.contract,
      provenance: materialized.provenance,
    };
    deps.writer(command.json ? JSON.stringify(payload, null, 2) : formatDryRun(payload));
    return;
  }

  // Live run.
  const goal = command.goal?.trim() || materialized.renderedInstructions.trim();
  if (goal === "") {
    throw new UsageError(
      "recipe run needs a goal: provide --goal or a non-empty recipe `instructions`",
    );
  }
  const topology = materialized.contract.topology;
  if (topology === undefined) {
    throw new UsageError("recipe run requires the recipe to declare agent_topology with roles");
  }

  const { resolveRecipeMcpServers } = await import("../../core/recipe-extensions.js");
  const extraMcpServers = resolveRecipeMcpServers(recipe.extensions ?? []);

  const { findGroveDir } = await import("../context.js");
  const groveDir = findGroveDir(deps.cwd);
  if (groveDir === undefined) {
    throw new UsageError("Not inside a grove. Run 'grove init' first.");
  }
  const groveRoot = resolve(groveDir, "..");

  const { buildRepos } = await import("../utils/build-repos.js");
  const repos = buildRepos({ rawRepo: [...command.repos], cwd: groveRoot });

  const launch = deps.launch ?? (await import("../utils/launch-session.js")).launchGoalSession;
  const result = await launch({
    groveDir,
    groveRoot,
    goal,
    topology,
    contract: materialized.contract,
    repos,
    ...(extraMcpServers.length > 0 && { extraMcpServers: [...extraMcpServers] }),
    recipeProvenance: materialized.provenance,
    onAgentsStarted: ({ sessionId, agents }) => {
      deps.writer(
        command.json
          ? JSON.stringify(
              {
                sessionId,
                recipe: { name: recipe.name, version: recipe.version },
                recipeDigest: bound.recipeDigest,
                agents: agents.map((a) => ({ role: a.role, status: a.session.status })),
              },
              null,
              2,
            )
          : `Recipe session started: ${recipe.name}@${recipe.version} (${sessionId}) ` +
              `with ${agents.length} agents`,
      );
    },
  });
  if (!command.json) {
    deps.writer(`Recipe session ${result.sessionId} ended: ${result.stopReason}`);
  }
}

function resolveRecipePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function parseParamFlags(flags: readonly string[]): Readonly<Record<string, string>> {
  const params: Record<string, string> = {};
  for (const flag of flags) {
    const equals = flag.indexOf("=");
    if (equals <= 0) throw new UsageError(`Invalid --param: ${flag}`);
    params[flag.slice(0, equals)] = flag.slice(equals + 1);
  }
  return params;
}

function formatDryRun(payload: {
  readonly recipe: { readonly name: string; readonly version: string };
  readonly recipeDigest: string;
  readonly boundParameterDigest: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly renderedInstructions?: string | undefined;
}): string {
  const lines = [
    `Recipe dry-run: ${payload.recipe.name}@${payload.recipe.version}`,
    `Recipe digest: ${payload.recipeDigest}`,
    `Bound digest: ${payload.boundParameterDigest}`,
    `Parameters: ${JSON.stringify(payload.parameters)}`,
  ];
  if (payload.renderedInstructions !== undefined) {
    lines.push("Rendered instructions:");
    lines.push(payload.renderedInstructions);
  }
  return lines.join("\n");
}
