# wasm-mesher (Rust crate)

Rust crate for Minecraft chunk meshing and packet parsing, compiled to
WebAssembly. Used by the JS-side worker in `src/wasm-mesher/`.

## Layout

```
wasm-mesher/
├── src/                     ← Rust source
│   ├── lib.rs               ← wasm_bindgen entry points (the public API below)
│   ├── chunk.rs             ← chunk data structures + fast indexing
│   ├── chunk_parser_common.rs
│   ├── parser_v16_v17.rs    ← 1.16 / 1.17 raw map_chunk parser
│   ├── parser_v18plus.rs    ← 1.18+ raw map_chunk parser
│   ├── dump_parser.rs       ← prismarine-chunk dump() byte parser (1.18+)
│   ├── mesher.rs            ← greedy meshing
│   ├── geometry.rs          ← vertices / indices / uvs
│   ├── lighting.rs          ← AO + light blending
│   └── utils.rs
├── tests/                   ← TS test harnesses (see `src/wasm-mesher/tests/`
│                              for the in-repo unit tests)
│   ├── test-chunk.ts        ← snapshot test (1.16.5 fixture)
│   ├── test-section-boundary.ts
│   ├── test-chunk-shared.ts ← shared helpers
│   ├── test.html
│   └── test.sh
├── pkg/                     ← `--target nodejs` build output (test-only, not committed)
├── target/                  ← cargo build cache
├── Cargo.toml
├── build.sh                 ← release build → src/wasm-mesher/runtime-build/
└── build.mjs                ← bundles tests/*.ts → tests/*.cjs for node runs
```

The `--target web` artefacts produced by `build.sh` are placed in the
JS-side runtime directory:
`../src/wasm-mesher/runtime-build/{wasm_mesher.js,wasm_mesher_bg.wasm,*.d.ts}`.

The `--target nodejs` artefacts (used by `test:wasm*` scripts) are placed
in `pkg/` next to this README.

## Public API (lib.rs)

| `js_name`                          | Purpose                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `generate_geometry`                | Mesh a single section. Inputs: block-state arrays, biomes, light, palettes. |
| `generate_geometry_multi`          | Mesh many sections in one call (full column).                              |
| `parseChunkDump118`                | Parse `column.dump()` bytes (1.18+) → `{blockStates, biomes}` typed arrays. |
| `parseChunkDump118FullColumn`      | Same + lays out blocks/biomes in `convertChunkToWasm` order.               |
| `parseChunkDump118FullColumnAll`   | Variant-1 production drop-in: parses blocks + biomes + skyLight + blockLight in one call. |
| `parseChunkDump118NoMarshal`       | Bench-only: parses dump but returns checksum, no Vec materialisation.      |
| `unpackLightSection118`            | Unpack a single 4-bit packed light section.                                |
| `generateGeometryFromDump118`      | Variant-3 PoC: fused parse + mesh in one Rust call (kept for experiments). |
| `parseMapChunkV18Plus`             | Parse a raw `map_chunk` packet payload, 1.18+ format.                      |
| `parseChunkSectionsV16V17`         | Parse 1.16 / 1.17 chunk sections (palette + bit-packed states).            |
| `parseUpdateLightV17`              | Parse a 1.17 `update_light` packet.                                        |

History of why each entry-point exists is in
`docs/issues/issue-15-wasm/history.md`.

## Building

```bash
# Web target (consumed by the JS worker in src/wasm-mesher/worker)
./build.sh web                        # release; writes to src/wasm-mesher/runtime-build/
./build.sh web dev                    # dev build (faster, larger)

# From the renderer root, equivalent:
pnpm build:wasm

# Node target (consumed by tests; written to ./pkg)
wasm-pack build --target nodejs --out-dir pkg --dev

# Bundle tests/*.ts → tests/*.cjs
node build.mjs
```

`build.sh` requires `wasm-pack` on PATH and runs `wasm-opt` for release
builds. Output is cleaned of wasm-pack's auto-generated
`README.md` / `package.json` / `.gitignore` so they don't pollute the JS tree.

## Testing

```bash
# From the renderer root:
pnpm test:wasm                # snapshot (1.16.5) + boundary + heightmap parity
pnpm test:wasm:boundary       # boundary + heightmap only

# Rust unit tests:
cargo test
```

The TS-level WASM unit tests (`heightmapParity`, `splitColumnWasmOutput`,
`mesherWasmConversionCache`) live in `src/wasm-mesher/tests/` and are run
by vitest as part of `pnpm unit-test`.

## Performance

See `docs/issues/issue-15-wasm/history.md` for benchmark history. Headline:
`parseChunkDump118FullColumnAll` is **~2.2× faster** than the JS extract
path on real-world Paper 1.18.2 chunks; meshing itself dominates the rest
of the pipeline (~95% of total time).
