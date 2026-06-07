# Minecraft Renderer

![Minecraft Renderer](./logo.webp)

A modular Minecraft world renderer with Three.js WebGL backend. Designed for performance testing, experimentation, and integration into Minecraft clients.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         AppViewer                                │
│  - Manages graphics backend lifecycle                            │
│  - Handles world view and player state                           │
│  - Coordinates between data and rendering                        │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     GraphicsBackend (Three.js)                   │
│  - WebGL rendering via Three.js                                  │
│  - Scene, camera, and lighting management                        │
│  - Mesher worker coordination                                    │
└─────────────────────────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ DocumentRenderer │  │WorldGeometryHandler│ │    StarField     │
│ - Render loop    │  │ - Chunk meshes    │  │ - Night sky      │
│ - Canvas sizing  │  │ - GPU memory      │  │ - Twinkling      │
│ - FPS tracking   │  │ - Signs/banners   │  │   effect         │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

## Core Components

### WorldView (formerly WorldDataEmitter)

Manages chunk loading/unloading and emits world events to the renderer.

```typescript
import { WorldView } from 'minecraft-renderer'

// Create world view with a world provider
const worldView = new WorldView(worldProvider, renderDistance, startPosition)

// Initialize and start loading chunks
await worldView.init(playerPosition)

// Update position (loads/unloads chunks as needed)
await worldView.updatePosition(newPosition)

// Set block and emit update
worldView.setBlockStateId(position, stateId)
```

### AppViewer

Main application entry point for integrating the renderer.

```typescript
import { AppViewer, createGraphicsBackend } from 'minecraft-renderer'

const viewer = new AppViewer({
  config: {
    sceneBackground: 'lightblue',
    fpsLimit: 60
  },
  rendererConfig: {
    enableLighting: true,
    smoothLighting: true,
    showChunkBorders: false
  }
})

// Load backend
await viewer.loadBackend(createGraphicsBackend)

// Start rendering world
await viewer.startWorld(worldProvider, renderDistance)

// Update camera each frame
viewer.updateCamera(position, yaw, pitch)
```

### Settings flow (app integration)

Renderer-owned options live in `RENDERER_DEFAULT_OPTIONS` and `RENDERER_OPTIONS_META` (`src/graphicsBackend/rendererDefaultOptions.ts`).

1. **Defaults** — spread `RENDERER_DEFAULT_OPTIONS` into your app options store (e.g. valtio `options`).
2. **Migration** — call `migrateRendererOptions(saved)` when loading persisted settings (legacy mesher/GPU keys → current renderer option names).
3. **Settings UI** — merge `RENDERER_OPTIONS_META` into your options meta; layout can stay app-owned.
4. **Menu startup** — `startMenuBackground(menuBackgroundOptionsFromStorage(options))`.
5. **Runtime sync** — after `AppViewer` + backend init, call once:
   `subscribeRendererOptions(appViewer, options, { isSafari, isCypress, onRegisterFocusHandlers })`.
   This updates `inWorldRenderingConfig`, `appViewer.config` (FPS/stats), and live menu-background controls when `currentDisplay === 'menu'`.
6. **App-only** — keep `volume` and bot/world hooks in the client (`applyRendererEnableLighting`, `applyRendererWorldViewOptions`, weather).

| Change | Live update | Reload required |
|--------|-------------|-----------------|
| Menu V2 scene / camera / speeds | Yes (`backend.getMenuBackground`) | Mode switch needs restart |
| `rendererMesher` (`wasm` / `legacy-js`) | Proxy flag syncs | Yes — mesher worker script swap |
| `rendererWorldPerformance` | Config syncs | Yes — worker count |
| Volume | App `watchValue` only | No |

Sync runs on the **main thread** only; `inWorldRenderingConfig` uses existing valtio `__syncToWorker` for off-thread backends. Do not call `subscribeRendererOptions` from mesher workers.

## How Block Rendering Works

### 1. Chunk Data Flow

```
World Provider → WorldView → GraphicsBackend → Mesher Workers → Three.js Scene
```

1. **World Provider**: Provides chunk column data (prismarine-chunk format)
2. **WorldView**: Emits `loadChunk` events with serialized chunk data
3. **GraphicsBackend**: Receives events and dispatches to mesher workers
4. **Mesher Workers**: Generate geometry (positions, normals, UVs, colors)
5. **Three.js Scene**: Creates BufferGeometry meshes from worker output

### 2. Mesher Worker Communication

Workers receive:
- Block data (chunk JSON with block state IDs)
- Block models and textures atlas
- Lighting configuration

Workers produce:
- Float32Array of vertex positions (x, y, z per vertex)
- Float32Array of normals
- Float32Array of colors (vertex colors for lighting)
- Float32Array of UVs (texture coordinates)
- Uint16/32Array of indices

### 3. Geometry Structure

Each block face is a quad with 4 vertices and 6 indices:

```typescript
interface MesherGeometryOutput {
  positions: Float32Array  // [x1,y1,z1, x2,y2,z2, ...]
  normals: Float32Array    // [nx,ny,nz, ...]
  colors: Float32Array     // [r,g,b, r,g,b, ...] (0-1 range, lighting)
  uvs: Float32Array        // [u1,v1, u2,v2, ...] (texture atlas coords)
  indices: Uint32Array     // [0,1,2, 2,3,0, ...] (triangles)
  sx, sy, sz: number       // Section position offset
  blocksCount: number      // Number of non-air blocks
  signs: Record<string, SignData>
  banners: Record<string, BannerData>
  heads: Record<string, HeadData>
}
```

### 4. Block Model Resolution

1. Block state ID → Block state properties
2. Block state properties → Blockstate JSON
3. Blockstate JSON → Model variants
4. Model JSON → Faces with texture references
5. Texture references → Atlas UV coordinates

### 5. Lighting Calculation

Lighting uses both block light and sky light:

```typescript
// Light level 0-15 for both block and sky light
const blockLight = chunk.getBlockLight(pos)
const skyLight = chunk.getSkyLight(pos)

// Combined light level
const light = Math.max(blockLight, skyLight * skyLightMultiplier)

// Light level to color multiplier
const brightness = lightLevelToBrightness[light]
// Applied as vertex color: [brightness, brightness, brightness]
```

### 6. Ambient Occlusion

Smooth lighting uses ambient occlusion based on neighboring blocks:

```typescript
// For each vertex, check 3 neighboring blocks
// AO value = (side1 + side2 + corner) / 3
// Applied as vertex color darkening
```

## Configuration

### WorldRendererConfig

```typescript
interface WorldRendererConfig {
  // Performance
  mesherWorkers: number           // Number of worker threads (default: 4)
  addChunksBatchWaitTime: number  // Batch delay for chunk loading (ms)
  _experimentalSmoothChunkLoading: boolean

  // Rendering
  enableLighting: boolean         // Enable block/sky lighting
  smoothLighting: boolean         // Enable ambient occlusion
  dayCycle: boolean              // Enable time-based sky changes
  starfield: boolean             // Enable star field at night
  fov: number                    // Camera field of view

  // Debug
  showChunkBorders: boolean      // Show chunk boundary helpers
  enableDebugOverlay: boolean    // Show advanced stats
  clipWorldBelowY: number | undefined  // Don't render below Y level
}
```

## Memory Management

The renderer implements several memory optimizations:

1. **CPU Array Disposal**: After GPU upload, CPU-side typed arrays are nulled
2. **Texture Caching**: Signs and banners share textures via reference counting
3. **Section Tracking**: Memory usage is tracked per section for debugging

```typescript
// Get memory usage
const { bytes, readable } = worldGeometryHandler.getMemoryUsageReadable()
console.log(`GPU Memory: ${readable}`)  // e.g., "45.32 MB"
```

## Performance Tips

1. **Mesher Workers**: Increase `mesherWorkers` on multi-core systems
2. **Smooth Loading**: Enable `_experimentalSmoothChunkLoading` to prevent frame drops
3. **Clip World**: Use `clipWorldBelowY` to reduce geometry for surface views
4. **Disable Lighting**: Set `enableLighting: false` for faster meshing

## Development

```bash
# Install dependencies
pnpm install

# Run playground
pnpm dev

# Build library
pnpm build

# Type check
pnpm typecheck
```

## File Structure

```
src/
├── index.ts              # Main exports
├── types.ts              # TypeScript types
├── config.ts             # Default configurations
├── appViewer.ts          # Main application viewer
├── worldView.ts          # Chunk loading/events (WorldDataEmitter)
├── playerState.ts        # Player state management
├── three/                # Three.js backend
│   ├── index.ts          # Backend exports
│   ├── graphicsBackend.ts    # Main backend entry
│   ├── documentRenderer.ts   # Render loop management
│   ├── worldGeometryHandler.ts   # Chunk geometry
│   └── starField.ts      # Night sky effect
└── playground/           # Development environment
    ├── playground.ts     # Main playground entry
    └── playground.html   # HTML template
```

## Integration Example

```typescript
import { AppViewer, createGraphicsBackend, WorldView } from 'minecraft-renderer'
import ChunkLoader from 'prismarine-chunk'
import WorldLoader from 'prismarine-world'

// Setup world (using prismarine-world)
const World = WorldLoader('1.20.4')
const Chunk = ChunkLoader('1.20.4')
const world = new World().sync

// Create viewer
const viewer = new AppViewer()

// Provide resources (textures, models)
viewer.resourcesManager = {
  currentConfig: { version: '1.20.4' },
  currentResources: {
    blocksAtlasImage: atlasImage,
    blocksAtlasJson: atlasJson,
    blockstatesModels: modelsData,
    allReady: true
  },
  on: () => {}
}

// Load backend
await viewer.loadBackend(createGraphicsBackend)

// Start world
await viewer.startWorld(world, 4)  // 4 chunk render distance

// Initialize world view
await viewer.worldView!.init(new Vec3(0, 64, 0))

// Game loop
function gameLoop() {
  viewer.updateCamera(playerPosition, playerYaw, playerPitch)
  requestAnimationFrame(gameLoop)
}
gameLoop()
```

## License

MIT
