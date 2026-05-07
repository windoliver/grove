# Nexus-Hosted Skill Distribution - Design

- **Date:** 2026-05-07
- **Issue:** [#326](https://github.com/windoliver/grove/issues/326)
- **Parent:** [#202](https://github.com/windoliver/grove/issues/202)
- **Builds on:** [#262](https://github.com/windoliver/grove/issues/262), `docs/superpowers/specs/2026-04-20-native-skill-injection-design.md`
- **Status:** Approved design, pending implementation plan

## Summary

Grove already supports per-role native skill injection from local catalogs:
bundled `<groveRoot>/skills/` plus workspace override
`<projectRoot>/.grove/skills/`. Nexus-mode sessions still require every host
to have the same local Grove checkout or local override tree available.

This design adds automatic Nexus-backed skill resolution in Nexus mode. When a
role declares `skills: ["grove"]`, Grove tries a signed Nexus catalog first,
falls back to a last verified cache, then falls back to the existing local
catalogs. Nexus content is never injected unless it verifies against trusted
Ed25519 public keys from local `.grove/grove.json`.

## Goals

- In Nexus mode, agents on different machines can receive the same role skills
  without requiring each host to have the Grove repo checked out.
- Preserve the existing `skills: [...]` role field and provider-native injection
  paths.
- Verify externally fetched skill content before injecting it into an agent
  workspace.
- Provide an offline path through a last verified local cache.
- Keep non-Nexus mode behavior unchanged.
- Default to warn-and-fallback so existing sessions do not fail because the
  network catalog is unavailable.

## Non-Goals

- Runtime hot-reload of skills during an active agent session.
- Agent-initiated skill acquisition.
- Trusting keys served only by Nexus. The first trust anchor must be local or
  built into Grove.
- A full package registry UI.
- Solving every publication workflow in the first implementation. Publishing
  can be a follow-up child issue if needed.

## Current State

- `src/core/skill-injector.ts` resolves skill names against local override and
  bundled roots, then copies the selected directory to `.claude/skills/{name}/`
  and `.codex/skills/{name}/`.
- `src/core/workspace-bootstrap.ts`, `src/core/session-orchestrator.ts`, and
  `src/tui/spawn-manager.ts` already pass role-level `skills`.
- `src/nexus/nexus-cas.ts` provides BLAKE3-addressed blob storage over Nexus
  VFS.
- `src/shared/zip.ts` can create dependency-free stored ZIP archives for
  diagnostics, but Grove does not yet have a ZIP reader.
- `.grove/grove.json` is strict and currently stores backend mode, Nexus URL,
  and service metadata.

## Design

### Architecture

Skill resolution becomes a mode-aware resolver:

1. **Nexus catalog** - only in Nexus mode. Reads a signed catalog index from
   Nexus, verifies it with local trust keys, downloads the requested bundle,
   checks the BLAKE3 bundle hash, unpacks it to cache, then injects from cache.
2. **Verified local cache** - used when Nexus is down or the index cannot be
   fetched. Only bundles that were verified in a previous successful fetch are
   eligible.
3. **Existing local catalogs** - workspace override first, then bundled skills.

The existing `injectSkills()` function remains the final copy step. The new
resolver produces a temporary/catalog root containing verified skill
directories, then calls the existing injector with that root.

Non-Nexus mode keeps the current local-only flow.

### Nexus Catalog Layout

Catalog files live under the current Nexus zone:

```text
/zones/<zoneId>/skill-catalog/index.json
/zones/<zoneId>/skill-catalog/index.sig
/zones/<zoneId>/skill-catalog/bundles/<blake3-hash>.zip
```

The bundle path is derived from the verified `bundleHash`; Grove does not trust
an arbitrary path from the index.

`index.json` is canonical JSON:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-07T00:00:00Z",
  "skills": {
    "grove": {
      "version": "2026.05.07",
      "bundleHash": "blake3:<hex64>",
      "sizeBytes": 1234
    }
  }
}
```

`index.sig` contains the key ID and base64 Ed25519 signature over the exact
canonical `index.json` bytes:

```json
{
  "schemaVersion": 1,
  "keyId": "grove-root-2026-05",
  "algorithm": "ed25519",
  "signature": "<base64>"
}
```

Each ZIP bundle contains one skill directory's contents at archive root:

```text
SKILL.md
references/...
scripts/...
```

Bundles must use stored ZIP entries only. This keeps unpacking
dependency-free, bounded, and compatible with `src/shared/zip.ts`.

### Trust Configuration

Extend `.grove/grove.json` with optional skill catalog settings:

```json
{
  "name": "example",
  "mode": "nexus",
  "nexusUrl": "http://localhost:2026",
  "skillCatalog": {
    "policy": "warn-and-fallback",
    "trustedKeys": [
      {
        "id": "grove-root-2026-05",
        "algorithm": "ed25519",
        "publicKeySpkiDer": "<base64-spki-der-public-key>"
      }
    ],
    "cacheTtlSeconds": 86400
  }
}
```

Policy values:

- `warn-and-fallback` - default. Try Nexus first, warn on fetch/trust failures,
  then use verified cache or local catalogs.
- `required` - fail spawn if a requested skill cannot be resolved from a
  verified Nexus catalog or verified cache.

Trusted keys may also be shipped as built-in Grove defaults for Grove-owned
skills. Nexus cannot be the only source of trust keys because that would let a
compromised Nexus instance serve both modified skill content and the key that
trusts it.

`publicKeySpkiDer` is base64-encoded SPKI DER, so implementation can import it
with standard crypto APIs without relying on provider-specific raw-key parsing.

### Cache Layout

Verified cache lives under the local `.grove` directory:

```text
.grove/cache/skills/
  index.json
  index.sig
  bundles/<blake3-hash>.zip
  unpacked/<skill-name>/<version>/<blake3-hash>/SKILL.md
  manifest.json
```

`manifest.json` records:

- source Nexus URL and zone ID
- skill name, version, and bundle hash
- verified key ID
- verified timestamp
- unpacked directory path

The cache is content-addressed by bundle hash. Cache TTL controls when Grove
attempts to refresh from Nexus; expired cache entries remain usable as offline
fallback if they were previously verified.

### Resolution Flow

For each role with `skills` in Nexus mode:

1. Load trusted skill catalog settings from `.grove/grove.json`.
2. Fetch `index.json` and `index.sig` from Nexus.
3. Verify the signature using a trusted key.
4. For each requested skill, locate an index entry by name.
5. Fetch the zone-scoped bundle path derived from `bundleHash`.
6. Recompute BLAKE3 over the ZIP bytes and compare with `bundleHash`.
7. Unpack only safe ZIP paths to the verified cache.
8. Confirm the unpacked root contains `SKILL.md`.
9. Inject from the verified cache via the existing native injector.

Fallback order when Nexus cannot satisfy the request:

1. Last verified cache.
2. Workspace override `.grove/skills/{name}`.
3. Bundled `<groveRoot>/skills/{name}`.

Under `required`, steps 2 and 3 of fallback are disabled.

### Error Handling

New structured errors:

- `SkillCatalogTrustError` - missing signature, unknown key ID, unsupported
  algorithm, bad signature, or no trusted keys.
- `SkillCatalogUnavailableError` - Nexus unreachable, index missing, bundle
  missing, or catalog schema invalid.
- `SkillBundleIntegrityError` - bundle hash mismatch, unsafe ZIP entry path,
  unsupported ZIP method, size limit exceeded, or missing `SKILL.md`.
- Existing `SkillResolutionError` - requested skill is absent from every
  allowed source.

Warnings must include skill name, attempted source, fallback source, and reason.
They must not print Nexus API keys, bearer tokens, or local credential contents.

### Public Surfaces

New modules:

- `src/core/skill-catalog.ts`
  - catalog schemas and types
  - canonical JSON encode/decode
  - Ed25519 signature verification
  - BLAKE3 bundle hash verification
  - stored-ZIP unpack validation
- `src/nexus/nexus-skill-catalog.ts`
  - zone-scoped path helpers
  - Nexus VFS read/write helpers for catalog files and bundles
  - resolver that returns verified cache directories

Modified modules:

- `src/core/config.ts` - parse/write optional `skillCatalog`.
- `src/core/workspace-bootstrap.ts` - accept an optional pre-resolved skill
  catalog root or resolver dependency.
- `src/core/session-orchestrator.ts` - in Nexus mode, create and pass a
  Nexus-aware resolver.
- `src/tui/spawn-manager.ts` - mirror the same resolver in the TUI spawn path.
- `src/shared/zip.ts` - add a minimal stored-ZIP reader/unpacker or a sibling
  module if that keeps the writer simpler.

CLI publication can be deferred, but the design leaves room for:

```bash
grove skill publish --catalog nexus --skill grove --key <key-id>
grove skill sync --from ./skills --catalog nexus
```

### Testing

Unit tests:

- canonical JSON output is stable regardless of object insertion order.
- Ed25519 verification accepts the matching key and rejects bad signatures,
  wrong keys, and unsupported algorithms.
- BLAKE3 bundle hash mismatch rejects before unpack.
- ZIP unpack rejects absolute paths, parent-relative paths, duplicate entries,
  unsupported compression methods, directory traversal, and oversized bundles.
- Valid bundle unpacks to a directory with `SKILL.md` and siblings preserved.

Nexus adapter tests:

- `MockNexusClient` serves a signed catalog and bundle.
- missing index falls back under `warn-and-fallback`.
- missing bundle falls back under `warn-and-fallback`.
- bad signature never uses Nexus content.
- `required` policy fails without verified Nexus or cache.

Bootstrap integration tests:

- Nexus mode injects verified Nexus skill.
- Nexus unavailable uses last verified cache.
- no cache falls back to local bundled skill under default policy.
- non-Nexus mode behavior remains byte-for-byte equivalent to current local
  injection tests.

### Security Notes

- The signature authenticates the catalog index, not the Nexus transport.
- The BLAKE3 hash authenticates the ZIP bytes selected by the signed index.
- ZIP extraction must validate every path before writing any file.
- The resolver must resolve all requested skills before injection so a partial
  failure does not inject half of a role's skill set.
- Cache entries remain immutable once verified. Refresh creates or points to a
  new `{skillName, version, bundleHash}` directory.

## Migration

Existing local and Nexus sessions continue to work. Roles still declare skills
with `skills: [...]`. Without `skillCatalog.trustedKeys` or built-in trusted
keys, Nexus mode warns and falls back to verified cache or local catalogs.

Operators who want strict remote distribution set:

```json
{
  "skillCatalog": {
    "policy": "required",
    "trustedKeys": [...]
  }
}
```

## Proposed Child Issues

1. **feat(skills): add signed skill catalog core**
   - `src/core/skill-catalog.ts`
   - canonical JSON, Ed25519 verification, BLAKE3 checks, stored-ZIP unpacker
2. **feat(nexus): add Nexus skill catalog adapter**
   - zone-scoped VFS paths, signed index reads, bundle fetches, verified cache
3. **feat(runtime): resolve skills from Nexus in Nexus mode**
   - wire `SessionOrchestrator`, `SpawnManager`, and bootstrap integration
4. **feat(cli): publish skills to Nexus catalog**
   - package local skill dirs, sign index, write bundles and catalog to Nexus
5. **docs(skills): document Nexus-hosted skill catalogs**
   - config examples, trust model, offline fallback, and required policy

## Open Questions

None. The approved defaults are automatic Nexus resolution in Nexus mode,
local trust keys in `.grove/grove.json`, and warn-and-fallback policy unless an
operator opts into `required`.
