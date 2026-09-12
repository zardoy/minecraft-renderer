import { RendererLightCache } from './rendererLightCache'

export type LightPublicationSection = {
  sx: number
  sy: number
  sz: number
  blockLight: Uint8Array
  skyLight?: Uint8Array
}

export type LightPublication = {
  worldGeneration: number
  publicationVersion: number
  sections: LightPublicationSection[]
}

export type LightOwnerEvent =
  | { type: 'ingestBlockSection'; sx: number; sy: number; sz: number; states: Uint16Array }
  | { type: 'setAvailability'; sx: number; sy: number; sz: number; availability: 'loaded' | 'lightOnly' | 'unloaded' }
  | { type: 'serverLight'; sx: number; sy: number; sz: number; channel: 'block' | 'sky'; kind: 'omitted' | 'empty' | 'data'; data?: Uint8Array }
  | { type: 'blockChange'; x: number; y: number; z: number; stateId: number }
  | { type: 'unloadColumn'; sx: number; sz: number }

export type LightEngineBackend = {
  setLightTables(tables: { emission: Uint8Array; opacity: Uint8Array }): void
  pushEvent(event: LightOwnerEvent): void
  step(budgetMs: number): boolean
  pollCompletedPublication(): LightPublication | null
}

export type PublicationGate = {
  acceptedGeneration: number
  lastVersion: number
}

export type ApplyPublicationResult = { applied: boolean; lastVersion: number }

/** Engine ABI uses section indices; RendererLightCache keys are world origins. */
export function sectionIndexToWorldOrigin(sx: number, sy: number, sz: number) {
  return { sx: sx * 16, sy: sy * 16, sz: sz * 16 }
}

export function applyLightPublication(
  cache: RendererLightCache,
  publication: LightPublication,
  gate: PublicationGate,
  coords: 'world' | 'section-index' = 'world'
): ApplyPublicationResult {
  if (publication.worldGeneration !== gate.acceptedGeneration) {
    return { applied: false, lastVersion: gate.lastVersion }
  }
  if (publication.publicationVersion <= gate.lastVersion) {
    return { applied: false, lastVersion: gate.lastVersion }
  }
  const sections = publication.sections.map(section => {
    const origin = coords === 'section-index' ? sectionIndexToWorldOrigin(section.sx, section.sy, section.sz) : section
    return {
      sx: origin.sx,
      sy: origin.sy,
      sz: origin.sz,
      blockLight: section.blockLight,
      skyLight: section.skyLight
    }
  })
  cache.ingestPackedSections(sections)
  return { applied: true, lastVersion: publication.publicationVersion }
}

/** Production spawn stays behind `enableClientLightOwner` (default off). */
export const CLIENT_LIGHT_OWNER_FLAG = 'enableClientLightOwner' as const

export class LightOwnerHost {
  private lastVersion = 0
  private readonly generation: number

  private constructor(
    private readonly cache: RendererLightCache,
    private readonly backend: LightEngineBackend,
    opts: { worldMinY: number; worldHeight: number; generation?: number }
  ) {
    this.generation = opts.generation ?? 1
    this.cache.setWorldBounds(opts.worldMinY, opts.worldHeight)
  }

  static create(cache: RendererLightCache, backend: LightEngineBackend, opts: { worldMinY: number; worldHeight: number; generation?: number }) {
    return new LightOwnerHost(cache, backend, opts)
  }

  static async createInProcess(cache: RendererLightCache, opts: { worldMinY: number; worldHeight: number; generation?: number }) {
    const backend = await createWasmLightBackend(opts.worldMinY, opts.worldHeight)
    return new LightOwnerHost(cache, backend, opts)
  }

  setLightTables(tables: { emission: Uint8Array; opacity: Uint8Array }) {
    this.backend.setLightTables(tables)
  }

  pushEvent(event: LightOwnerEvent) {
    this.backend.pushEvent(event)
  }

  async stepUntilIdle(maxSlices = 32, budgetMs = 16): Promise<LightPublication | undefined> {
    let last: LightPublication | undefined
    for (let i = 0; i < maxSlices; i++) {
      const remaining = this.backend.step(budgetMs)
      const publication = this.backend.pollCompletedPublication()
      if (publication) {
        const result = applyLightPublication(this.cache, publication, { acceptedGeneration: this.generation, lastVersion: this.lastVersion }, 'section-index')
        if (result.applied) {
          this.lastVersion = result.lastVersion
          last = publication
        }
      }
      if (!remaining) break
    }
    return last
  }
}

async function createWasmLightBackend(worldMinY: number, worldHeight: number): Promise<LightEngineBackend> {
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const wasmModule = await import('../wasm-mesher/runtime-build/wasm_mesher.js')
  const wasmDir = dirname(fileURLToPath(import.meta.url))
  const wasmBytes = readFileSync(join(wasmDir, '../wasm-mesher/runtime-build/wasm_mesher_bg.wasm'))
  try {
    if (typeof wasmModule.initSync === 'function') {
      wasmModule.initSync(wasmBytes)
    } else {
      await wasmModule.default(wasmBytes)
    }
  } catch {
    // wasm already initialized in this vitest worker
  }
  const Engine = (wasmModule as { JsLightEngine?: new (minY: number, height: number) => WasmEngine }).JsLightEngine
  if (!Engine) {
    throw new Error('JsLightEngine is not exported from wasm_mesher')
  }
  const engine = new Engine(worldMinY, worldHeight)
  return {
    setLightTables({ emission, opacity }) {
      engine.setLightTables(emission, opacity)
    },
    pushEvent(event) {
      engine.pushEvent(event)
    },
    step(budgetMs) {
      return engine.step(budgetMs)
    },
    pollCompletedPublication() {
      const raw = engine.pollCompletedPublication()
      if (!raw) return null
      return {
        worldGeneration: raw.worldGeneration,
        publicationVersion: raw.publicationVersion,
        sections: raw.sections.map((section: { sx: number; sy: number; sz: number; blockLight: Uint8Array }) => ({
          sx: section.sx,
          sy: section.sy,
          sz: section.sz,
          blockLight: section.blockLight
        }))
      }
    }
  }
}

type WasmEngine = {
  setLightTables(emission: Uint8Array, opacity: Uint8Array): void
  pushEvent(event: LightOwnerEvent): void
  step(budgetMs: number): boolean
  pollCompletedPublication(): null | {
    worldGeneration: number
    publicationVersion: number
    sections: Array<{ sx: number; sy: number; sz: number; blockLight: Uint8Array }>
  }
}
