# Vendored Roblox API-Dump.json

This directory holds a pinned snapshot of Roblox's official API dump, the
input that drives `scripts/gen-roblox-defs.mjs` when generating the
Roblox-globals Luau definitions file that ships in the WASM analyzer.

## Current snapshot

- **Version hash:** `version-d0e8cfcd943d4ae2`
- **Fetched:** 2026-05-15
- **Size:** ~4.1 MB (682 classes, 351 enums)

## How to refresh

```sh
HASH="$(curl -fsSL https://setup.rbxcdn.com/versionQTStudio)"
curl -fsSL "https://setup.rbxcdn.com/${HASH}-API-Dump.json" -o API-Dump.json
# Then update the "Version hash" / "Fetched" lines above.
# Then re-run the generator and rebuild the WASM:
node packages/analyzer/scripts/gen-roblox-defs.mjs
bash packages/analyzer/build/build.sh
```

The dump is committed so builds are reproducible without network access.
Roblox bumps the Studio version weekly; refreshing periodically picks up
new APIs, deprecated removals, and signature changes.
