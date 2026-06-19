import type { CubeDrawSpan } from './cubeDrawSpans'
import { MAX_CUBE_SPANS } from './cubeDrawSpans'
import { VERTICES_PER_FACE } from './shaders/cubeBlockShader'

export type MultiDrawTier = 'A' | 'B' | 'C'

export type MultiDrawCaps = {
  tier: MultiDrawTier
  ext: MultiDrawInstancedExt | DrawInstancedBaseExt | null
}

type MultiDrawInstancedExt = {
  multiDrawArraysInstancedBaseInstanceWEBGL: (
    mode: number,
    firsts: Int32Array,
    firstsOffset: number,
    counts: Int32Array,
    countsOffset: number,
    instanceCounts: Int32Array,
    instanceCountsOffset: number,
    baseInstances: Int32Array,
    baseInstancesOffset: number,
    drawCount: number,
  ) => void
}

type DrawInstancedBaseExt = {
  drawArraysInstancedBaseInstanceWEBGL: (
    mode: number,
    first: number,
    count: number,
    instanceCount: number,
    baseInstance: number,
  ) => void
}

export type CubeMultiDrawScratch = {
  firsts: Int32Array
  counts: Int32Array
  instanceCounts: Int32Array
  baseInstances: Int32Array
}

export function createCubeMultiDrawScratch (): CubeMultiDrawScratch {
  return {
    firsts: new Int32Array(MAX_CUBE_SPANS),
    counts: new Int32Array(MAX_CUBE_SPANS),
    instanceCounts: new Int32Array(MAX_CUBE_SPANS),
    baseInstances: new Int32Array(MAX_CUBE_SPANS),
  }
}

export function detectMultiDrawCaps (gl: WebGL2RenderingContext): MultiDrawCaps {
  const tierA = gl.getExtension('WEBGL_multi_draw_instanced_base_vertex_base_instance')
  if (tierA) {
    return { tier: 'A', ext: tierA as MultiDrawInstancedExt }
  }
  const tierB = gl.getExtension('WEBGL_draw_instanced_base_vertex_base_instance')
  if (tierB) {
    return { tier: 'B', ext: tierB as DrawInstancedBaseExt }
  }
  return { tier: 'C', ext: null }
}

let tierLogged = false

export function logMultiDrawTierOnce (tier: MultiDrawTier, debug: boolean): void {
  if (tierLogged || !debug) return
  tierLogged = true
  console.info('[globalBlockBuffer] cube multi_draw tier', tier)
}

/**
 * Issue instanced cube draws for visible spans. Tier C delegates to buffer-owned VAO path.
 */
export function drawCubeSpans (
  gl: WebGL2RenderingContext,
  caps: MultiDrawCaps,
  spans: readonly CubeDrawSpan[],
  scratch: CubeMultiDrawScratch,
  tierCDraw?: (gl: WebGL2RenderingContext, spans: readonly CubeDrawSpan[]) => void,
): void {
  const drawCount = spans.length
  if (drawCount === 0) return

  const mode = gl.TRIANGLES

  if (caps.tier === 'A' && caps.ext) {
    const ext = caps.ext as MultiDrawInstancedExt
    for (let i = 0; i < drawCount; i++) {
      const span = spans[i]!
      scratch.firsts[i] = 0
      scratch.counts[i] = VERTICES_PER_FACE
      scratch.instanceCounts[i] = span.count
      scratch.baseInstances[i] = span.start
    }
    ext.multiDrawArraysInstancedBaseInstanceWEBGL(
      mode,
      scratch.firsts, 0,
      scratch.counts, 0,
      scratch.instanceCounts, 0,
      scratch.baseInstances, 0,
      drawCount,
    )
    return
  }

  if (caps.tier === 'B' && caps.ext) {
    const ext = caps.ext as DrawInstancedBaseExt
    for (let i = 0; i < drawCount; i++) {
      const span = spans[i]!
      ext.drawArraysInstancedBaseInstanceWEBGL(mode, 0, VERTICES_PER_FACE, span.count, span.start)
    }
    return
  }

  tierCDraw?.(gl, spans)
}
