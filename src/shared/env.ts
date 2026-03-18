import { z } from "zod";

const PortSchema = z.coerce.number().int().min(1).max(65535);

export function parsePort(raw: string | undefined, defaultPort: number): number {
  if (raw === undefined) return defaultPort;
  const result = PortSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid PORT: '${raw}'. Must be an integer between 1 and 65535.`);
  }
  return result.data;
}

export function parseGossipSeeds(
  raw: string | undefined,
): readonly { peerId: string; address: string; age: number; lastSeen: string }[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((seed) => {
      const trimmed = seed.trim();
      if (!trimmed) return null;
      const atIndex = trimmed.indexOf("@");
      if (atIndex < 1) {
        throw new Error(`GOSSIP_SEEDS: invalid format '${trimmed}'. Expected 'id@url'.`);
      }
      const id = trimmed.slice(0, atIndex);
      const address = trimmed.slice(atIndex + 1);
      try {
        new URL(address);
      } catch {
        throw new Error(`GOSSIP_SEEDS: invalid URL '${address}' for peer '${id}'.`);
      }
      return { peerId: id, address, age: 0, lastSeen: new Date().toISOString() };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
}
