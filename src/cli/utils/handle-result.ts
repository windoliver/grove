/**
 * Shared operation-result error handling for CLI commands.
 *
 * Most commands follow the same pattern when an operation fails:
 *   if (!result.ok) {
 *     if (json) { outputJsonError(result.error); return; }
 *     throw new Error(result.error.message);
 *   }
 *
 * This helper encapsulates that pattern so each command doesn't
 * have to repeat it.
 */

import type { OperationError } from "../../core/operations/result.js";
import { outputJsonError } from "../format.js";

/**
 * Handle a failed operation result with consistent JSON/human output.
 *
 * - In JSON mode: writes the structured error via outputJsonError (sets exitCode 1) and returns true.
 * - In human mode: throws an Error with the operation's message.
 *
 * Usage:
 *   if (!result.ok) {
 *     handleOperationError(result.error, values.json);
 *     return;  // only reached in JSON mode
 *   }
 */
export function handleOperationError(error: OperationError, json: boolean | undefined): void {
  if (json) {
    outputJsonError(error);
    return;
  }
  throw new Error(error.message);
}
