# WASM Mesher

High-performance Minecraft mesher written in Rust, compiled to WebAssembly.

## Setup

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install wasm-pack
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Build WASM package
wasm-pack build --target web

# Output will be in pkg/
```

## Usage

```typescript
import init, { generate_geometry } from './pkg/wasm_mesher.js';

await init();

const result = generate_geometry(
    section_x, section_y, section_z, section_height,
    world_min_y, world_max_y,
    section_data_start_y,
    block_states, block_light, sky_light, biomes,
    invisible_blocks, transparent_blocks,
    no_ao_blocks, cull_identical_blocks, occluding_blocks,
    enable_lighting, smooth_lighting, sky_light_value
);

// result contains: positions, normals, colors, uvs, indices
```

## Performance Goals

- **Target**: 20-30ms (M1 Pro), 80-120ms (mobile)
- **Current JS**: 85ms (M1 Pro), 340ms (mobile)
- **Improvement**: 3-4× faster

## Architecture

- **chunk.rs**: Efficient chunk data structures with fast indexing
- **lighting.rs**: AO and light calculations
- **geometry.rs**: Geometry generation (vertices, indices)
- **mesher.rs**: Main meshing logic
- **utils.rs**: Utility functions

## Development

```bash
# Build
wasm-pack build --target web --dev

# Test (runs the snapshot test + the boundary/heightmap fixtures)
pnpm test:wasm                # from the renderer root
pnpm test:wasm:boundary       # boundary + heightmap fixtures only

# Regenerate snapshot after intentional output changes:
# delete the snapshot file and re-run; it will be re-created.
#   rm test-snapshots/1.16.5/wasm-chunk.snapshot.json && pnpm test:wasm

# Rust unit tests
cargo test

# Benchmark (when implemented)
cargo bench
```
