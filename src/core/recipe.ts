/**
 * Grove recipe parser, digest helpers, parameter binding, and dry-run materialization.
 *
 * Wire format uses snake_case YAML. TypeScript types use camelCase.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { hash } from "blake3";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { GroveContract } from "./contract.js";
import type { JsonValue } from "./models.js";
import { type AgentTopology, AgentTopologySchema, wireToTopology } from "./topology.js";

const DIGEST_PREFIX = "blake3:";
const NamePattern = /^[a-z][a-z0-9_-]*$/;
const ParameterNamePattern = /^[a-z][a-z0-9_]*$/;
const SemverPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine((n) => Number.isFinite(n), { message: "JSON numbers must be finite" }),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const JsonObjectSchema: z.ZodType<Readonly<Record<string, JsonValue>>> = z.record(
  z.string(),
  JsonValueSchema,
);

export type RecipeParameterType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "enum"
  | "path"
  | "json";

const BaseParameterSchema = z
  .object({
    required: z.boolean().optional(),
    description: z.string().max(1024).optional(),
  })
  .strict();

const StringParameterSchema = BaseParameterSchema.extend({
  type: z.literal("string"),
  default: z.string().optional(),
}).strict();

const IntegerParameterSchema = BaseParameterSchema.extend({
  type: z.literal("integer"),
  default: z.number().int().optional(),
}).strict();

const NumberParameterSchema = BaseParameterSchema.extend({
  type: z.literal("number"),
  default: z
    .number()
    .refine((n) => Number.isFinite(n), "number default must be finite")
    .optional(),
}).strict();

const BooleanParameterSchema = BaseParameterSchema.extend({
  type: z.literal("boolean"),
  default: z.boolean().optional(),
}).strict();

const EnumParameterSchema = BaseParameterSchema.extend({
  type: z.literal("enum"),
  enum: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .refine((values) => new Set(values).size === values.length, {
      message: "duplicate enum values",
    }),
  default: z.string().optional(),
})
  .strict()
  .superRefine((parameter, ctx) => {
    if (parameter.default !== undefined && !parameter.enum.includes(parameter.default)) {
      ctx.addIssue({
        code: "custom",
        message: "enum parameter default must be in enum values",
        path: ["default"],
      });
    }
  });

const PathParameterSchema = BaseParameterSchema.extend({
  type: z.literal("path"),
  default: z.string().optional(),
}).strict();

const JsonParameterSchema = BaseParameterSchema.extend({
  type: z.literal("json"),
  default: JsonValueSchema.optional(),
}).strict();

const RecipeParameterSchema = z.discriminatedUnion("type", [
  StringParameterSchema,
  IntegerParameterSchema,
  NumberParameterSchema,
  BooleanParameterSchema,
  EnumParameterSchema,
  PathParameterSchema,
  JsonParameterSchema,
]);

const RecipeExtensionSchema = z
  .object({
    type: z.enum(["mcp", "tool", "provider", "service"]),
    name: z.string().regex(NamePattern).min(1).max(128),
    uri: z.string().min(1).max(1024).optional(),
    required: z.boolean().optional(),
  })
  .strict();

const RecipeActivitySchema = z
  .object({
    id: z.string().regex(NamePattern).min(1).max(128),
    label: z.string().min(1).max(256),
    role: z.string().regex(NamePattern).min(1).max(64).optional(),
    condition: z.string().min(1).max(1024).optional(),
  })
  .strict();

const ContextManifestRefSchema = z
  .object({
    ref: z.string().min(1).max(1024),
    role: z.string().regex(NamePattern).min(1).max(64).optional(),
    required: z.boolean().optional(),
  })
  .strict();

const RecipeSubRecipeSchema = z
  .object({
    name: z.string().regex(NamePattern).min(1).max(128),
    ref: z.string().min(1).max(1024),
    when: z.string().min(1).max(1024).optional(),
    parameters: z
      .record(z.string().regex(ParameterNamePattern).max(64), JsonValueSchema)
      .refine((value) => Object.keys(value).length <= 100, {
        message: "max 100 sub-recipe parameters",
      })
      .optional(),
  })
  .strict();

const ResponseSchema = z
  .object({
    schema: JsonObjectSchema.optional(),
  })
  .strict();

const RecipeRunPolicySchema = z
  .object({
    max_iterations: z.number().int().min(1).optional(),
    max_no_improvement_rounds: z.number().int().min(1).optional(),
    improvement_threshold: z.number().min(0).optional(),
    direction: z.enum(["maximize", "minimize"]).optional(),
  })
  .strict();

const RecipeLibraryMetadataSchema = z
  .object({
    owner: z.string().min(1).max(128).optional(),
    license: z.string().min(1).max(128).optional(),
    source: z.string().min(1).max(1024).optional(),
    visibility: z.enum(["private", "workspace", "public"]).optional(),
  })
  .strict();

const GroveRecipeWireSchema = z
  .object({
    kind: z.literal("recipe"),
    recipe_version: z.literal(1),
    name: z.string().regex(NamePattern).min(1).max(128),
    version: z.string().regex(SemverPattern).max(64),
    description: z.string().max(1024).optional(),
    labels: z
      .array(z.string().min(1).max(64))
      .max(50)
      .refine((labels) => new Set(labels).size === labels.length, {
        message: "duplicate labels",
      })
      .optional(),
    parameters: z
      .record(z.string().regex(ParameterNamePattern).max(64), RecipeParameterSchema)
      .refine((value) => Object.keys(value).length <= 100, {
        message: "max 100 parameters",
      })
      .optional(),
    extensions: z.array(RecipeExtensionSchema).max(50).optional(),
    activities: z
      .array(RecipeActivitySchema)
      .max(100)
      .superRefine((activities, ctx) => {
        const ids = activities.map((activity) => activity.id);
        if (new Set(ids).size !== ids.length) {
          ctx.addIssue({ code: "custom", message: "duplicate activity ids" });
        }
      })
      .optional(),
    instructions: z.string().max(20000).optional(),
    agent_topology: AgentTopologySchema.optional(),
    context_manifests: z.array(ContextManifestRefSchema).max(50).optional(),
    sub_recipes: z.array(RecipeSubRecipeSchema).max(50).optional(),
    response: ResponseSchema.optional(),
    run_policy: RecipeRunPolicySchema.optional(),
    library: RecipeLibraryMetadataSchema.optional(),
  })
  .strict();

type GroveRecipeWire = z.infer<typeof GroveRecipeWireSchema>;

export type RecipeParameter = Readonly<{
  type: RecipeParameterType;
  required?: boolean | undefined;
  description?: string | undefined;
  enum?: readonly string[] | undefined;
  default?: JsonValue | undefined;
}>;

export interface RecipeExtension {
  readonly type: "mcp" | "tool" | "provider" | "service";
  readonly name: string;
  readonly uri?: string | undefined;
  readonly required?: boolean | undefined;
}

export interface RecipeActivity {
  readonly id: string;
  readonly label: string;
  readonly role?: string | undefined;
  readonly condition?: string | undefined;
}

export interface RecipeSubRecipe {
  readonly name: string;
  readonly ref: string;
  readonly when?: string | undefined;
  readonly parameters?: Readonly<Record<string, JsonValue>> | undefined;
}

export interface RecipeRunPolicy {
  readonly maxIterations?: number | undefined;
  readonly maxNoImprovementRounds?: number | undefined;
  readonly improvementThreshold?: number | undefined;
  readonly direction?: "maximize" | "minimize" | undefined;
}

export interface RecipeLibraryMetadata {
  readonly owner?: string | undefined;
  readonly license?: string | undefined;
  readonly source?: string | undefined;
  readonly visibility?: "private" | "workspace" | "public" | undefined;
}

export interface GroveRecipe {
  readonly kind: "recipe";
  readonly recipeVersion: 1;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly parameters?: Readonly<Record<string, RecipeParameter>> | undefined;
  readonly extensions?: readonly RecipeExtension[] | undefined;
  readonly activities?: readonly RecipeActivity[] | undefined;
  readonly instructions?: string | undefined;
  readonly topology?: AgentTopology | undefined;
  readonly contextManifests?:
    | readonly {
        readonly ref: string;
        readonly role?: string | undefined;
        readonly required?: boolean | undefined;
      }[]
    | undefined;
  readonly subRecipes?: readonly RecipeSubRecipe[] | undefined;
  readonly response?:
    | { readonly schema?: Readonly<Record<string, JsonValue>> | undefined }
    | undefined;
  readonly runPolicy?: RecipeRunPolicy | undefined;
  readonly library?: RecipeLibraryMetadata | undefined;
}

export interface BoundRecipe {
  readonly recipe: GroveRecipe;
  readonly recipeDigest: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly renderedInstructions: string;
}

export interface RecipeProvenance {
  readonly recipeDigest: string;
  readonly recipeName: string;
  readonly recipeVersion: string;
  readonly boundParameterDigest: string;
  readonly subRecipeDigests: readonly string[];
  readonly sourceRef?: string | undefined;
}

export interface MaterializedRecipe {
  readonly contract: GroveContract;
  readonly provenance: RecipeProvenance;
  readonly renderedInstructions: string;
}

export type RecipeSource = "project" | "workspace" | "user";

export interface DiscoveredRecipe {
  readonly path: string;
  readonly source: RecipeSource;
  readonly recipe: GroveRecipe;
  readonly digest: string;
}

export interface DiscoverRecipesOptions {
  readonly cwd: string;
  readonly homeConfigDir?: string | undefined;
}

function canonicalize(value: unknown): string {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new Error(`Unsupported value in canonical JSON: ${typeof value}`);
  }

  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      throw new Error("NaN is not allowed in canonical JSON");
    }
    if (!Number.isFinite(value)) {
      throw new Error("Infinity is not allowed in canonical JSON");
    }
    return JSON.stringify(value);
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return `[${items.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Unsupported non-plain object in canonical JSON");
  }

  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .reduce<string[]>((acc, key) => {
      const v = obj[key];
      if (v !== undefined) {
        if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
          throw new Error(`Unsupported value in canonical JSON at key '${key}'`);
        }
        acc.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
      }
      return acc;
    }, []);
  return `{${entries.join(",")}}`;
}

function digestJson(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalize(value));
  return `${DIGEST_PREFIX}${hash(bytes).toString("hex")}`;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

function wireToParameter(parameter: z.infer<typeof RecipeParameterSchema>): RecipeParameter {
  return {
    type: parameter.type,
    ...(parameter.required !== undefined && { required: parameter.required }),
    ...(parameter.description !== undefined && { description: parameter.description }),
    ...("enum" in parameter && { enum: parameter.enum }),
    ...(parameter.default !== undefined && { default: parameter.default as JsonValue }),
  };
}

function wireToRunPolicy(wire: z.infer<typeof RecipeRunPolicySchema>): RecipeRunPolicy {
  return {
    ...(wire.max_iterations !== undefined && { maxIterations: wire.max_iterations }),
    ...(wire.max_no_improvement_rounds !== undefined && {
      maxNoImprovementRounds: wire.max_no_improvement_rounds,
    }),
    ...(wire.improvement_threshold !== undefined && {
      improvementThreshold: wire.improvement_threshold,
    }),
    ...(wire.direction !== undefined && { direction: wire.direction }),
  };
}

function wireToRecipe(wire: GroveRecipeWire): GroveRecipe {
  return {
    kind: wire.kind,
    recipeVersion: wire.recipe_version,
    name: wire.name,
    version: wire.version,
    ...(wire.description !== undefined && { description: wire.description }),
    ...(wire.labels !== undefined && { labels: wire.labels }),
    ...(wire.parameters !== undefined && {
      parameters: Object.fromEntries(
        Object.entries(wire.parameters).map(([name, parameter]) => [
          name,
          wireToParameter(parameter),
        ]),
      ),
    }),
    ...(wire.extensions !== undefined && { extensions: wire.extensions }),
    ...(wire.activities !== undefined && { activities: wire.activities }),
    ...(wire.instructions !== undefined && { instructions: wire.instructions }),
    ...(wire.agent_topology !== undefined && { topology: wireToTopology(wire.agent_topology) }),
    ...(wire.context_manifests !== undefined && { contextManifests: wire.context_manifests }),
    ...(wire.sub_recipes !== undefined && {
      subRecipes: wire.sub_recipes.map((subRecipe) => ({
        name: subRecipe.name,
        ref: subRecipe.ref,
        ...(subRecipe.when !== undefined && { when: subRecipe.when }),
        ...(subRecipe.parameters !== undefined && { parameters: subRecipe.parameters }),
      })),
    }),
    ...(wire.response !== undefined && { response: wire.response }),
    ...(wire.run_policy !== undefined && { runPolicy: wireToRunPolicy(wire.run_policy) }),
    ...(wire.library !== undefined && { library: wire.library }),
  };
}

function toRecipeDigestInput(recipe: GroveRecipe): Record<string, unknown> {
  return {
    kind: recipe.kind,
    recipeVersion: recipe.recipeVersion,
    name: recipe.name,
    version: recipe.version,
    description: recipe.description,
    labels: recipe.labels,
    parameters: recipe.parameters,
    extensions: recipe.extensions,
    activities: recipe.activities,
    instructions: recipe.instructions,
    topology: recipe.topology,
    contextManifests: recipe.contextManifests,
    subRecipes: recipe.subRecipes,
    response: recipe.response,
    runPolicy: recipe.runPolicy,
    library: recipe.library,
  };
}

function validateBoundValue(name: string, parameter: RecipeParameter, value: JsonValue): void {
  if (parameter.type === "string" || parameter.type === "path") {
    if (typeof value !== "string") {
      throw new Error(`parameter '${name}' must be a string`);
    }
    return;
  }
  if (parameter.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`parameter '${name}' must be an integer`);
    }
    return;
  }
  if (parameter.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`parameter '${name}' must be a finite number`);
    }
    return;
  }
  if (parameter.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new Error(`parameter '${name}' must be a boolean`);
    }
    return;
  }
  if (parameter.type === "enum") {
    if (
      typeof value !== "string" ||
      parameter.enum === undefined ||
      !parameter.enum.includes(value)
    ) {
      throw new Error(`parameter '${name}' must be one of its enum values`);
    }
    return;
  }
  JsonValueSchema.parse(value);
}

function lookupTemplateValue(
  parameters: Readonly<Record<string, JsonValue>>,
  parameterDefinitions: Readonly<Record<string, RecipeParameter>> | undefined,
  expression: string,
): JsonValue {
  const path = expression.trim().split(".");
  if (path.length < 2 || path[0] !== "parameters") {
    throw new Error(`unsupported recipe template expression '${expression}'`);
  }

  const parameterName = path[1];
  if (parameterName === undefined || !ParameterNamePattern.test(parameterName)) {
    throw new Error(`invalid recipe template parameter reference '${expression}'`);
  }

  const initialValue = parameters[parameterName];
  if (initialValue === undefined) {
    throw new Error(`missing recipe template parameter '${parameterName}'`);
  }

  if (path.length > 2 && parameterDefinitions?.[parameterName]?.type !== "json") {
    throw new Error(`nested recipe template paths require json parameter '${parameterName}'`);
  }

  let value: JsonValue = initialValue;
  for (const segment of path.slice(2)) {
    if (!ParameterNamePattern.test(segment)) {
      throw new Error(`invalid recipe template path segment '${segment}'`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`recipe template path '${expression}' does not resolve to an object`);
    }
    const nextValue = value[segment];
    if (nextValue === undefined) {
      throw new Error(`recipe template path '${expression}' is missing '${segment}'`);
    }
    value = nextValue;
  }

  return value;
}

function stringifyTemplateValue(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return JSON.stringify(value);
}

export function parseGroveRecipe(content: string): GroveRecipe {
  const raw: unknown = parseYaml(content);
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new Error("Grove recipe YAML is not a valid object");
  }
  return parseGroveRecipeObject(raw);
}

export function parseGroveRecipeObject(obj: unknown): GroveRecipe {
  const result = GroveRecipeWireSchema.safeParse(obj);
  if (!result.success) {
    throw new Error(`Invalid Grove recipe: ${formatZodIssues(result.error)}`);
  }
  return wireToRecipe(result.data);
}

export function computeRecipeDigest(recipe: GroveRecipe): string {
  return digestJson(toRecipeDigestInput(recipe));
}

export function computeBoundRecipeDigest(bound: BoundRecipe): string {
  return digestJson({
    recipeDigest: bound.recipeDigest,
    parameters: bound.parameters,
    renderedInstructions: bound.renderedInstructions,
  });
}

export function renderRecipeTemplate(
  template: string,
  parameters: Readonly<Record<string, JsonValue>>,
  parameterDefinitions?: Readonly<Record<string, RecipeParameter>>,
): string {
  let rendered = "";
  let cursor = 0;

  while (cursor < template.length) {
    const markerStart = template.indexOf("${", cursor);
    if (markerStart === -1) {
      rendered += template.slice(cursor);
      break;
    }

    const literal = template.slice(cursor, markerStart);
    rendered += literal;

    const markerEnd = template.indexOf("}", markerStart + 2);
    if (markerEnd === -1) {
      throw new Error("malformed recipe template syntax");
    }

    const expression = template.slice(markerStart + 2, markerEnd);
    if (expression.trim() === "") {
      throw new Error("malformed recipe template syntax");
    }
    rendered += stringifyTemplateValue(
      lookupTemplateValue(parameters, parameterDefinitions, expression),
    );
    cursor = markerEnd + 1;
  }

  return rendered;
}

export function bindRecipeParameters(
  recipe: GroveRecipe,
  overrides: Readonly<Record<string, JsonValue>>,
): BoundRecipe {
  const parameterDefinitions = recipe.parameters ?? {};
  for (const name of Object.keys(overrides)) {
    if (parameterDefinitions[name] === undefined) {
      throw new Error(`unknown recipe parameter '${name}'`);
    }
  }

  const boundParameters: Record<string, JsonValue> = {};
  for (const [name, parameter] of Object.entries(parameterDefinitions)) {
    const override = overrides[name];
    const value =
      override !== undefined ? coerceParameterValue(name, parameter, override) : parameter.default;
    if (value === undefined) {
      if (parameter.required === true) {
        throw new Error(`missing required recipe parameter '${name}'`);
      }
      continue;
    }
    validateBoundValue(name, parameter, value);
    boundParameters[name] = value;
  }

  const renderedInstructions =
    recipe.instructions !== undefined
      ? renderRecipeTemplate(recipe.instructions, boundParameters, parameterDefinitions)
      : "";

  return {
    recipe,
    recipeDigest: computeRecipeDigest(recipe),
    parameters: boundParameters,
    renderedInstructions,
  };
}

function coerceParameterValue(
  name: string,
  definition: RecipeParameter,
  value: JsonValue,
): JsonValue {
  if (typeof value !== "string") return value;
  if (definition.type === "integer") {
    if (value.trim() === "" || !/^-?\d+$/.test(value)) {
      throw new Error(`Parameter ${name} must be an integer`);
    }
    return Number(value);
  }
  if (definition.type === "number") {
    if (value.trim() === "") throw new Error(`Parameter ${name} must be a number`);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Parameter ${name} must be a number`);
    return parsed;
  }
  if (definition.type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error(`Parameter ${name} must be true or false`);
  }
  if (definition.type === "json") {
    if (!looksLikeJsonSource(value)) return value;
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      throw new Error(`Parameter ${name} must be valid JSON`);
    }
  }
  return value;
}

function looksLikeJsonSource(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith('"') ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null" ||
    /^-?\d/.test(trimmed)
  );
}

export function materializeRecipeContract(bound: BoundRecipe): MaterializedRecipe {
  const contract: GroveContract = {
    contractVersion: 3,
    name: bound.recipe.name,
    ...(bound.recipe.description !== undefined && { description: bound.recipe.description }),
    ...(bound.recipe.topology !== undefined && { topology: bound.recipe.topology }),
    ...(bound.recipe.runPolicy?.maxIterations !== undefined && {
      stopConditions: {
        budget: {
          maxContributions: bound.recipe.runPolicy.maxIterations,
        },
      },
    }),
  };

  const boundDigest = computeBoundRecipeDigest(bound);
  return {
    contract,
    provenance: {
      recipeDigest: bound.recipeDigest,
      recipeName: bound.recipe.name,
      recipeVersion: bound.recipe.version,
      boundParameterDigest: boundDigest,
      subRecipeDigests: [],
    },
    renderedInstructions: bound.renderedInstructions,
  };
}

export async function discoverRecipes(
  options: DiscoverRecipesOptions,
): Promise<readonly DiscoveredRecipe[]> {
  const roots: readonly { readonly source: RecipeSource; readonly dir: string }[] = [
    { source: "project", dir: join(options.cwd, "recipes") },
    { source: "workspace", dir: join(options.cwd, ".grove", "recipes") },
    {
      source: "user",
      dir: options.homeConfigDir ?? join(process.env.HOME ?? "", ".config", "grove", "recipes"),
    },
  ];
  const discovered: DiscoveredRecipe[] = [];
  for (const root of roots) {
    for (const path of await listYamlFiles(root.dir)) {
      const content = await readFile(path, "utf-8");
      const recipe = parseGroveRecipe(content);
      discovered.push({
        path,
        source: root.source,
        recipe,
        digest: computeRecipeDigest(recipe),
      });
    }
  }
  return discovered.sort((a, b) => {
    const sourceRank = sourceOrder(a.source) - sourceOrder(b.source);
    if (sourceRank !== 0) {
      return sourceRank;
    }
    return compareCodeUnits(a.path, b.path) || compareCodeUnits(a.recipe.name, b.recipe.name);
  });
}

async function listYamlFiles(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await listYamlFiles(path)));
      }
      if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        files.push(path);
      }
    }
    return files.sort(compareCodeUnits);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function sourceOrder(source: RecipeSource): number {
  if (source === "project") {
    return 0;
  }
  if (source === "workspace") {
    return 1;
  }
  return 2;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
