/**
 * Comprehensive test suite for VFS path helpers.
 *
 * Covers:
 * 1. encodeSegment / decodeSegment roundtrips
 * 2. Path traversal prevention
 * 3. Path construction correctness for every helper
 * 4. Edge cases (null bytes, long strings, Unicode)
 */

import { describe, expect, test } from "bun:test";

import {
  activeClaimIndexPath,
  bountyPath,
  bountyStatusIndexPath,
  casMetaPath,
  casPath,
  claimPath,
  contributionPath,
  decodeSegment,
  encodeSegment,
  ftsIndexPath,
  outcomePath,
  outcomeStatusIndexPath,
  relationIndexPath,
  tagIndexPath,
  targetLockPath,
} from "./vfs-paths.js";

// ---------------------------------------------------------------------------
// 1. encodeSegment / decodeSegment roundtrips
// ---------------------------------------------------------------------------

describe("encodeSegment / decodeSegment", () => {
  test("normal alphanumeric string passes through unchanged", () => {
    expect(encodeSegment("hello123")).toBe("hello123");
    expect(decodeSegment("hello123")).toBe("hello123");
  });

  test("string with / is encoded to %2F", () => {
    expect(encodeSegment("a/b")).toBe("a%2Fb");
  });

  test("string with % is encoded to %25", () => {
    expect(encodeSegment("100%")).toBe("100%25");
  });

  test("empty string roundtrips", () => {
    const encoded = encodeSegment("");
    expect(encoded).toBe("");
    expect(decodeSegment(encoded)).toBe("");
  });

  test("string with both / and % is encoded correctly", () => {
    const input = "a/b%c";
    const encoded = encodeSegment(input);
    // % is encoded first -> a/b%25c, then / -> a%2Fb%25c
    expect(encoded).toBe("a%2Fb%25c");
    expect(decodeSegment(encoded)).toBe(input);
  });

  test("roundtrip: decode(encode(s)) === s for various inputs", () => {
    const cases = [
      "simple",
      "",
      "with/slash",
      "with%percent",
      "both/and%here",
      "multiple///slashes",
      "multiple%%%percents",
      "%2F",
      "%25",
      "abc123",
      "hello world",
      "special!@#$^&*()",
    ];
    for (const s of cases) {
      expect(decodeSegment(encodeSegment(s))).toBe(s);
    }
  });

  test("double-encoding differs from single encoding (% gets re-encoded)", () => {
    const input = "a/b";
    const singleEncoded = encodeSegment(input);
    const doubleEncoded = encodeSegment(singleEncoded);
    // single: a%2Fb, double: a%252Fb (the % in %2F gets re-encoded to %25)
    expect(singleEncoded).toBe("a%2Fb");
    expect(doubleEncoded).toBe("a%252Fb");
    expect(doubleEncoded).not.toBe(singleEncoded);
  });

  test("double-encoding of % produces nested encoding", () => {
    const input = "100%";
    const single = encodeSegment(input);
    const double = encodeSegment(single);
    expect(single).toBe("100%25");
    expect(double).toBe("100%2525");
    expect(double).not.toBe(single);
  });

  test("decode reverses encode but not double-encode in one step", () => {
    const input = "a/b%c";
    const doubleEncoded = encodeSegment(encodeSegment(input));
    // One round of decode should not recover the original
    expect(decodeSegment(doubleEncoded)).not.toBe(input);
    // Two rounds should
    expect(decodeSegment(decodeSegment(doubleEncoded))).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// 2. Path traversal prevention
// ---------------------------------------------------------------------------

describe("path traversal prevention", () => {
  test("zoneId containing ../ is encoded, not treated as traversal", () => {
    const path = casPath("../etc", "abc123");
    expect(path).toBe("/zones/..%2Fetc/cas/abc123");
    expect(path).not.toContain("/../");
    expect(path.startsWith("/zones/")).toBe(true);
  });

  test("zoneId containing ./ is encoded", () => {
    const path = casPath("./local", "abc123");
    expect(path).toBe("/zones/.%2Flocal/cas/abc123");
    expect(path.startsWith("/zones/")).toBe(true);
  });

  test("tag containing / is encoded", () => {
    const path = tagIndexPath("zone1", "../../evil", "cid1");
    expect(path).toContain("..%2F..%2Fevil");
    expect(path).not.toContain("/../");
    expect(path.startsWith("/zones/zone1/")).toBe(true);
  });

  test("cid containing / is encoded", () => {
    const path = contributionPath("zone1", "../../../etc/passwd");
    expect(path).toContain("..%2F..%2F..%2Fetc%2Fpasswd");
    expect(path).not.toContain("/../");
    expect(path.startsWith("/zones/zone1/")).toBe(true);
  });

  test("resulting paths always stay within /zones/{encoded_zone}/ prefix", () => {
    const maliciousZones = [
      "../",
      "../../",
      "../etc/passwd",
      "./",
      "zone/../../../etc",
      "/absolute/path",
    ];
    for (const zone of maliciousZones) {
      const path = casPath(zone, "hash");
      const encodedZone = encodeSegment(zone);
      expect(path).toBe(`/zones/${encodedZone}/cas/hash`);
      // The path should never have a raw ../ after /zones/
      const afterZones = path.slice("/zones/".length);
      expect(afterZones).not.toMatch(/(?:^|\/)\.\.(?:\/|$)/);
    }
  });

  test("contentHash with traversal is encoded in casPath", () => {
    const path = casPath("zone1", "../../etc/passwd");
    expect(path).toBe("/zones/zone1/cas/..%2F..%2Fetc%2Fpasswd");
  });

  test("bountyId with traversal is encoded in bountyPath", () => {
    const path = bountyPath("zone1", "../secret");
    expect(path).toBe("/zones/zone1/bounties/..%2Fsecret.json");
  });

  test("claimId with traversal is encoded in claimPath", () => {
    const path = claimPath("zone1", "../secret");
    expect(path).toBe("/zones/zone1/claims/..%2Fsecret.json");
  });
});

// ---------------------------------------------------------------------------
// 3. Path construction correctness
// ---------------------------------------------------------------------------

describe("path construction correctness", () => {
  const zone = "my-zone";
  const hash = "blake3abc123";
  const cid = "blake3def456";
  const tag = "important";
  const claimId = "claim-001";
  const bountyId = "bounty-001";
  const targetCid = "blake3target";
  const sourceCid = "blake3source";
  const status = "open";
  const targetRef = "ref-abc";

  test("casPath returns /zones/{zone}/cas/{hash}", () => {
    expect(casPath(zone, hash)).toBe(`/zones/${zone}/cas/${hash}`);
  });

  test("casMetaPath returns /zones/{zone}/cas/{hash}.meta", () => {
    expect(casMetaPath(zone, hash)).toBe(`/zones/${zone}/cas/${hash}.meta`);
  });

  test("contributionPath returns /zones/{zone}/contributions/{cid}.json", () => {
    expect(contributionPath(zone, cid)).toBe(`/zones/${zone}/contributions/${cid}.json`);
  });

  test("tagIndexPath returns /zones/{zone}/indexes/tags/{tag}/{cid}", () => {
    expect(tagIndexPath(zone, tag, cid)).toBe(`/zones/${zone}/indexes/tags/${tag}/${cid}`);
  });

  test("ftsIndexPath returns /zones/{zone}/indexes/fts/{cid}.json", () => {
    expect(ftsIndexPath(zone, cid)).toBe(`/zones/${zone}/indexes/fts/${cid}.json`);
  });

  test("relationIndexPath returns /zones/{zone}/indexes/relations/{target}/{source}.json", () => {
    expect(relationIndexPath(zone, targetCid, sourceCid)).toBe(
      `/zones/${zone}/indexes/relations/${targetCid}/${sourceCid}.json`,
    );
  });

  test("claimPath returns /zones/{zone}/claims/{claimId}.json", () => {
    expect(claimPath(zone, claimId)).toBe(`/zones/${zone}/claims/${claimId}.json`);
  });

  test("bountyPath returns /zones/{zone}/bounties/{bountyId}.json", () => {
    expect(bountyPath(zone, bountyId)).toBe(`/zones/${zone}/bounties/${bountyId}.json`);
  });

  test("outcomePath returns /zones/{zone}/outcomes/{cid}.json", () => {
    expect(outcomePath(zone, cid)).toBe(`/zones/${zone}/outcomes/${cid}.json`);
  });

  test("bountyStatusIndexPath returns /zones/{zone}/indexes/bounties/status/{status}/{bountyId}", () => {
    expect(bountyStatusIndexPath(zone, status, bountyId)).toBe(
      `/zones/${zone}/indexes/bounties/status/${status}/${bountyId}`,
    );
  });

  test("outcomeStatusIndexPath returns /zones/{zone}/indexes/outcomes/status/{status}/{cid}", () => {
    expect(outcomeStatusIndexPath(zone, status, cid)).toBe(
      `/zones/${zone}/indexes/outcomes/status/${status}/${cid}`,
    );
  });

  test("activeClaimIndexPath returns /zones/{zone}/indexes/claims/active/{targetRef}/{claimId}", () => {
    expect(activeClaimIndexPath(zone, targetRef, claimId)).toBe(
      `/zones/${zone}/indexes/claims/active/${targetRef}/${claimId}`,
    );
  });

  test("targetLockPath returns /zones/{zone}/indexes/claims/target-lock/{targetRef}", () => {
    expect(targetLockPath(zone, targetRef)).toBe(
      `/zones/${zone}/indexes/claims/target-lock/${targetRef}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("null bytes in input are preserved through encode/decode roundtrip", () => {
    const input = "before\x00after";
    const encoded = encodeSegment(input);
    expect(decodeSegment(encoded)).toBe(input);
  });

  test("null bytes in zoneId do not break path structure", () => {
    const path = casPath("zone\x00evil", "hash");
    // The null byte is preserved in the segment (not a / or %) so it stays
    expect(path).toBe("/zones/zone\x00evil/cas/hash");
    expect(path.startsWith("/zones/")).toBe(true);
  });

  test("very long string encodes and decodes correctly", () => {
    const longStr = "a".repeat(10000);
    const encoded = encodeSegment(longStr);
    expect(encoded).toBe(longStr); // no special chars, unchanged
    expect(decodeSegment(encoded)).toBe(longStr);
  });

  test("very long string with special characters roundtrips", () => {
    const longStr = "a/b%c/".repeat(1000);
    const encoded = encodeSegment(longStr);
    expect(decodeSegment(encoded)).toBe(longStr);
    expect(encoded).not.toContain("/");
  });

  test("unicode characters pass through encode/decode unchanged", () => {
    const inputs = [
      "\u00e9\u00e8\u00ea", // accented Latin
      "\u4f60\u597d\u4e16\u754c", // Chinese
      "\ud83d\ude80\ud83c\udf1f", // emoji
      "\u0410\u0411\u0412", // Cyrillic
      "\u00fc\u00f6\u00e4", // German umlauts
    ];
    for (const input of inputs) {
      const encoded = encodeSegment(input);
      expect(encoded).toBe(input); // no / or % so unchanged
      expect(decodeSegment(encoded)).toBe(input);
    }
  });

  test("unicode characters with slashes are handled", () => {
    const input = "\u4f60\u597d/\u4e16\u754c";
    const encoded = encodeSegment(input);
    expect(encoded).toBe("\u4f60\u597d%2F\u4e16\u754c");
    expect(decodeSegment(encoded)).toBe(input);
  });

  test("path with encoded zoneId containing unicode roundtrips", () => {
    const zone = "caf\u00e9/zone";
    const path = casPath(zone, "hash");
    expect(path).toBe("/zones/caf\u00e9%2Fzone/cas/hash");
    expect(path.startsWith("/zones/")).toBe(true);
  });

  test("string that looks like an already-encoded segment is re-encoded", () => {
    // If someone passes "%2F" as a literal value, the % should be encoded
    const input = "%2F";
    const encoded = encodeSegment(input);
    expect(encoded).toBe("%252F");
    expect(decodeSegment(encoded)).toBe(input);
  });

  test("string that looks like %25 is re-encoded", () => {
    const input = "%25";
    const encoded = encodeSegment(input);
    expect(encoded).toBe("%2525");
    expect(decodeSegment(encoded)).toBe(input);
  });
});
