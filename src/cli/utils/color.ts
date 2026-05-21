const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

let colorEnabled = true;

export function shouldEnableColor(
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[] = [],
): boolean {
  if (Object.hasOwn(env, "NO_COLOR")) return false;
  if (env.TERM === "dumb") return false;
  if (args.includes("--no-color")) return false;
  return true;
}

export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

export function colorize(text: string, open: string, close: string = RESET): string {
  return colorEnabled ? `${open}${text}${close}` : text;
}

export function formatNextCommandHint(message: string): string {
  return colorize(`hint: ${message}`, DIM);
}
