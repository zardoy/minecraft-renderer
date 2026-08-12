/**
 * Synthetic load generator for the GPU block buffer.
 *
 * Reproduces the allocation patterns that actually kill the tab on iOS, without needing a
 * server, a world, or a specific seed:
 *
 *   - `grow`      monotonic section adds → repeated capacity growth (+1M faces a step)
 *   - `churn`     interleaved add/remove → free-list fragmentation, the case where the
 *                 allocator can hold a large high-watermark while most of it is free
 *   - `sustained` fixed working set, sections replaced in place → upload-path pressure only
 *
 * Section coordinates are spread over a plausible render volume so the cull pass sees a
 * realistic distribution rather than one degenerate cluster.
 */

import type { PlaygroundContext, PlaygroundModule } from '../types'
import type { GlobalBlockBufferGPU } from '../../../webgpu/globalBlockBufferGPU'
import { WORD0, WORD2, WORD3 } from '../../../three/shaders/cubeBlockShader'

export type StressScenario = 'grow' | 'churn' | 'sustained'

export type GpuStressOptions = {
  scenario?: StressScenario
  /** Sections added per step. */
  sectionsPerStep?: number
  /** ms between steps. */
  stepIntervalMs?: number
  /** Faces per synthetic section (a dense 16³ shell is ~1500). */
  facesPerSection?: number
  /** Stop after this many sections have been added (grow/churn). */
  maxSections?: number
  /** Working-set size for churn/sustained. */
  workingSet?: number
}

/** Builds one synthetic section's worth of interleaved face words. */
function buildSectionWords(faceCount: number, sx: number, sy: number, sz: number): Uint32Array {
  const words = new Uint32Array(faceCount * 4)
  const sxBiased = (sx + WORD3.SECTION_BIAS) & WORD3.SECTION_MASK
  const szBiased = (sz + WORD3.SECTION_BIAS) & WORD3.SECTION_MASK

  for (let f = 0; f < faceCount; f++) {
    const o = f * 4
    const faceId = f % 6
    const lx = f % 16
    const ly = (f >> 4) % 16
    const lz = (f >> 8) % 16

    let w0 = 0
    w0 |= (lx & 0xf) << WORD0.LX_SHIFT
    w0 |= (ly & 0xf) << WORD0.LY_SHIFT
    w0 |= (lz & 0xf) << WORD0.LZ_SHIFT
    w0 |= (faceId & 7) << WORD0.FACE_SHIFT
    // Full AO on every corner.
    for (let c = 0; c < WORD0.NUM_CORNERS; c++) w0 |= 3 << (WORD0.AO_SHIFT + c * WORD0.AO_BITS_PER_CORNER)

    // Full sky light, no block light, on all four corners.
    const w1 = 0xf0_f0_f0_f0

    let w2 = 1 & ((1 << WORD2.TEX_INDEX_BITS) - 1)
    w2 |= ((sy + 4) & 0x1f) << WORD2.SECTION_Y_SHIFT
    w2 |= ((sxBiased >>> 16) & 0x3f) << WORD2.SECTION_X_HI_SHIFT
    w2 |= ((szBiased >>> 16) & 0x3f) << WORD2.SECTION_Z_HI_SHIFT

    const w3 = (sxBiased & 0xffff) | ((szBiased & 0xffff) << 16)

    words[o] = w0 >>> 0
    words[o + 1] = w1 >>> 0
    words[o + 2] = w2 >>> 0
    words[o + 3] = w3 >>> 0
  }
  return words
}

export function gpuStressModule(options: GpuStressOptions = {}): PlaygroundModule {
  const scenario = options.scenario ?? 'grow'
  const sectionsPerStep = options.sectionsPerStep ?? 8
  const stepIntervalMs = options.stepIntervalMs ?? 100
  const facesPerSection = options.facesPerSection ?? 1536
  const maxSections = options.maxSections ?? 20_000
  const workingSet = options.workingSet ?? 2048

  let blocks: GlobalBlockBufferGPU | undefined
  let harness: { setPhase(p: string): void; mark(m: string): void } | undefined
  let nextIndex = 0
  let sinceStep = 0
  const live: string[] = []
  let exhausted = false

  const sectionCoordFor = (index: number): [number, number, number] => {
    // 32x8x32 volume, then repeat outward — keeps sections spread across the frustum.
    const x = (index % 32) - 16
    const y = Math.floor(index / 32) % 8
    const z = (Math.floor(index / 256) % 32) - 16
    return [x, y, z]
  }

  return {
    name: 'gpuStress',
    order: 50,

    setup(ctx: PlaygroundContext) {
      blocks = ctx.get<GlobalBlockBufferGPU>('gpuBlocks')
      harness = ctx.get('memoryHarness')
      if (!blocks) {
        ctx.log('stress.skipped', { reason: 'no gpuBlocks provided — is the WebGPU backend module active?' })
        return
      }
      harness?.setPhase(scenario)
      ctx.log('stress.start', { scenario, facesPerSection, sectionsPerStep, maxSections })
    },

    update(ctx: PlaygroundContext, deltaMs: number) {
      if (!blocks || exhausted) return
      sinceStep += deltaMs
      if (sinceStep < stepIntervalMs) return
      sinceStep = 0

      for (let i = 0; i < sectionsPerStep; i++) {
        if (nextIndex >= maxSections) {
          exhausted = true
          harness?.mark(`scenario ${scenario} completed at ${nextIndex} sections`)
          ctx.log('stress.done', { scenario, sections: nextIndex, fragmentation: blocks.fragmentation })
          return
        }

        const index = nextIndex++
        const [sx, sy, sz] = sectionCoordFor(index)
        const key = scenario === 'sustained' ? `s${index % workingSet}` : `s${index}`
        const words = buildSectionWords(facesPerSection, sx, sy, sz)

        const ok = blocks.addSection(key, words, facesPerSection, sx, sy, sz)
        if (!ok) {
          exhausted = true
          const message = `addSection refused at ${index} sections — capacity ceiling reached (${blocks.capacity.toLocaleString()} faces)`
          harness?.mark(message)
          ctx.log('stress.ceiling', {
            scenario,
            sections: index,
            capacity: blocks.capacity,
            used: blocks.usedFaces,
            cpuMB: blocks.cpuBytes / 1_048_576
          })
          console.warn(`[gpuStress] ${message}`)
          return
        }

        if (scenario !== 'sustained') live.push(key)

        // Churn: once past the working set, drop an old section per add so the free list
        // fragments instead of the buffer simply growing.
        if (scenario === 'churn' && live.length > workingSet) {
          const victim = live.splice(Math.floor(Math.random() * live.length), 1)[0]
          if (victim) blocks.removeSection(victim)
        }
      }
    },

    teardown() {
      blocks?.dispose()
    }
  }
}
