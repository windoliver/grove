/**
 * grove export-dag — dump all contributions as JSON.
 *
 * Usage:
 *   grove export-dag              # all contributions as JSON
 *   grove export-dag --pretty     # pretty-printed JSON
 */

import { parseArgs } from "node:util";

import type { CliDeps, Writer } from "../context.js";

export interface ExportDagOptions {
  readonly pretty: boolean;
}

export function parseExportDagArgs(argv: string[]): ExportDagOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      pretty: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    pretty: values.pretty ?? false,
  };
}

export async function runExportDag(
  options: ExportDagOptions,
  deps: CliDeps,
  writer: Writer = console.log,
): Promise<void> {
  const contributions = await deps.store.list();

  const sorted = [...contributions].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );

  const json = options.pretty ? JSON.stringify(sorted, null, 2) : JSON.stringify(sorted);

  writer(json);
}
