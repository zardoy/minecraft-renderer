import { BlockType } from '../playground/shared'

export const SECTION_HEIGHT = 16

// only here for easier testing
export const defaultMesherConfig = {
  version: '',
  worldMaxY: 256,
  worldMinY: 0,
  enableLighting: true,
  skyLight: 15,
  smoothLighting: true,
  shadingTheme: 'high-contrast' as 'vanilla' | 'high-contrast',
  cardinalLight: 'default' as string,
  outputFormat: 'threeJs' as 'threeJs' | 'webgpu',
  // textureSize: 1024, // for testing
  debugModelVariant: undefined as undefined | number[],
  clipWorldBelowY: undefined as undefined | number,
  disableBlockEntityTextures: false,
  disableConversionCache: false,
  computeWireframeEdges: false,
  /** Pack eligible full-cube faces as GPU-instanced shader words during WASM post-processing. */
  shaderCubeBlocks: false,
}

export type CustomBlockModels = {
  [blockPosKey: string]: string // blockPosKey is "x,y,z" -> model name
}

export type MesherConfig = typeof defaultMesherConfig

/** Vertex/index arrays for one opaque or blend geometry bucket. */
export type MesherGeometryBucketData = {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  skyLights: Float32Array
  blockLights: Float32Array
  uvs: Float32Array
  indices: Uint32Array | Uint16Array
}

export type MesherGeometryOutput = {
  sectionYNumber: number,
  chunkKey: string,
  sectionStartY: number,
  sectionEndY: number,
  sectionStartX: number,
  sectionEndX: number,
  sectionStartZ: number,
  sectionEndZ: number,
  // three.js
  sx: number,
  sy: number,
  sz: number,
  // resulting: float32array
  positions: any,
  normals: any,
  colors: any,
  skyLights: any,
  blockLights: any,
  uvs: any,
  /** Per-section blend geometry (water, lava, stained glass, ice, etc.). */
  blend?: MesherGeometryBucketData,

  indices: Uint32Array | Uint16Array | number[],
  indicesCount: number,
  using32Array: boolean,
  tiles: Record<string, BlockType>,
  heads: Record<string, any>,
  signs: Record<string, any>,
  banners: Record<string, any>,
  // isFull: boolean
  hadErrors: boolean
  blocksCount: number
  wireframePositions?: Float32Array
  customBlockModels?: CustomBlockModels
  /** GPU-instanced full-cube faces packed by the mesher; consumed by ChunkMeshManager. */
  shaderCubes?: {
    words: Uint32Array
    count: number
    formatVersion: 3
  }
}

export interface MesherMainEvents {
  geometry: { type: 'geometry'; key: string; geometry: MesherGeometryOutput; workerIndex: number };
  sectionFinished: {
    type: 'sectionFinished';
    key: string;
    workerIndex: number;
    processTime?: number;
    pre?: number;
    wasm?: number;
    post?: number;
    // Pre-stage substages (added for column-mode perf instrumentation).
    // All times in ms. `preNeighborConvert` is a SUM across neighbors;
    // divide by `preNeighborCount` for per-neighbor average.
    preTargetConvert?: number;
    preNeighborConvert?: number;
    preNeighborCount?: number;
    preTypedArrayBuild?: number;
    preOther?: number;
    // Per-event counts for the column-mode conversion cache.
    preCacheHits?: number;
    preCacheMisses?: number;
  };
  blockStateModelInfo: { type: 'blockStateModelInfo'; info: Record<string, BlockStateModelInfo> };
  heightmap: { type: 'heightmap'; key: string; heightmap: Int16Array };
  /** Reply to `{ type: 'mc-web-ping', t?, workerIndex? }` from the main thread (not batched in worker). */
  mcWebPong: { type: 'mc-web-pong'; workerIndex: number; t?: number; recvAt?: number };
}

export type MesherMainEvent = MesherMainEvents[keyof MesherMainEvents]

export type HighestBlockInfo = { y: number, stateId: number | undefined, biomeId: number | undefined }

export type BlockStateModelInfo = {
  cacheKey: string
  issues: string[]
  modelNames: string[]
  conditions: string[]
}

export const getBlockAssetsCacheKey = (stateId: number, modelNameOverride?: string) => {
  return modelNameOverride ? `${stateId}:${modelNameOverride}` : String(stateId)
}
