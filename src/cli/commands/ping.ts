/**
 * `grove ping` — print "pong".
 *
 * Simple health-check / smoke-test command.
 */

export async function handlePing(): Promise<void> {
  console.log("pong");
}
