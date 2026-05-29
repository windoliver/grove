import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export interface PromptDefinition {
  readonly name: string;
  readonly description: string;
  readonly template: string;
}

/** Load the prompts bundled in the repo `prompts/` directory. */
export async function listBundledPrompts(): Promise<readonly PromptDefinition[]> {
  return loadPromptDefinitions(new URL("../../prompts/", import.meta.url).pathname);
}

/** Load each *.md / *.txt file in `dir` as a named prompt (name = file stem). */
export async function loadPromptDefinitions(dir: string): Promise<readonly PromptDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const defs: PromptDefinition[] = [];
  for (const entry of entries.sort()) {
    const ext = extname(entry).toLowerCase();
    if (ext !== ".md" && ext !== ".txt") continue;
    const template = (await readFile(join(dir, entry), "utf8")).trim();
    if (template.length === 0) continue;
    const name = basename(entry, ext);
    const firstLine = template.split("\n", 1)[0]?.replace(/^#+\s*/, "") ?? name;
    defs.push({ name, description: firstLine.slice(0, 120), template });
  }
  return defs;
}
