export interface KeyInput {
  readonly name?: string | undefined;
  readonly sequence?: string | undefined;
}

export function matchesKey(key: KeyInput, expected: string): boolean {
  return key.name === expected || key.sequence === expected;
}
