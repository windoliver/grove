/**
 * Tests for shared env utilities (parsePort, parseGossipSeeds).
 */

import { describe, expect, test } from "bun:test";

import { parseGossipSeeds, parsePort } from "./env.js";

// ---------------------------------------------------------------------------
// parsePort
// ---------------------------------------------------------------------------

describe("parsePort", () => {
  test("returns the parsed number for a valid port string", () => {
    expect(parsePort("3000", 8080)).toBe(3000);
  });

  test("returns the default when raw is undefined", () => {
    expect(parsePort(undefined, 8080)).toBe(8080);
  });

  test("accepts boundary port 1", () => {
    expect(parsePort("1", 8080)).toBe(1);
  });

  test("accepts boundary port 65535", () => {
    expect(parsePort("65535", 8080)).toBe(65535);
  });

  test("throws on non-numeric string", () => {
    expect(() => parsePort("abc", 8080)).toThrow("Invalid PORT");
  });

  test("throws on port 0 (below range)", () => {
    expect(() => parsePort("0", 8080)).toThrow("Invalid PORT");
  });

  test("throws on port 65536 (above range)", () => {
    expect(() => parsePort("65536", 8080)).toThrow("Invalid PORT");
  });

  test("throws on negative port", () => {
    expect(() => parsePort("-1", 8080)).toThrow("Invalid PORT");
  });

  test("throws on floating-point string", () => {
    expect(() => parsePort("3000.5", 8080)).toThrow("Invalid PORT");
  });
});

// ---------------------------------------------------------------------------
// parseGossipSeeds
// ---------------------------------------------------------------------------

describe("parseGossipSeeds", () => {
  test("returns empty array when raw is undefined", () => {
    expect(parseGossipSeeds(undefined)).toEqual([]);
  });

  test("returns empty array when raw is empty string", () => {
    expect(parseGossipSeeds("")).toEqual([]);
  });

  test("parses a single valid seed", () => {
    const result = parseGossipSeeds("peer1@http://localhost:1234");
    expect(result).toHaveLength(1);
    expect(result[0]!.peerId).toBe("peer1");
    expect(result[0]!.address).toBe("http://localhost:1234");
    expect(result[0]!.age).toBe(0);
    expect(typeof result[0]!.lastSeen).toBe("string");
  });

  test("parses multiple comma-separated seeds", () => {
    const result = parseGossipSeeds(
      "peer1@http://host1:1111,peer2@http://host2:2222,peer3@http://host3:3333",
    );
    expect(result).toHaveLength(3);
    expect(result[0]!.peerId).toBe("peer1");
    expect(result[1]!.peerId).toBe("peer2");
    expect(result[2]!.peerId).toBe("peer3");
  });

  test("trims whitespace around seeds", () => {
    const result = parseGossipSeeds("  peer1@http://host:1234 , peer2@http://host:5678  ");
    expect(result).toHaveLength(2);
    expect(result[0]!.peerId).toBe("peer1");
    expect(result[1]!.peerId).toBe("peer2");
  });

  test("skips empty segments from trailing comma", () => {
    const result = parseGossipSeeds("peer1@http://host:1234,");
    expect(result).toHaveLength(1);
  });

  test("throws on missing @ separator", () => {
    expect(() => parseGossipSeeds("nope")).toThrow("invalid format");
  });

  test("throws when @ is the first character (empty id)", () => {
    expect(() => parseGossipSeeds("@http://host:1234")).toThrow("invalid format");
  });

  test("throws on invalid URL after @", () => {
    expect(() => parseGossipSeeds("peer@notaurl")).toThrow("invalid URL");
  });

  test("lastSeen is a valid ISO date string", () => {
    const result = parseGossipSeeds("peer1@http://localhost:9999");
    const parsed = new Date(result[0]!.lastSeen);
    expect(parsed.getTime()).not.toBeNaN();
  });
});
