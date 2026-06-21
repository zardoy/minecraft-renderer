import { MAX_OPAQUE_SPANS } from './globalLegacyBuffer'

export type LegacyMultiDrawTier = 'A' | 'B' | 'C'

export type LegacyDrawSpan = { indexStart: number, indexCount: number }

export type LegacyMultiDrawCaps = {
  tier: LegacyMultiDrawTier
  ext: MultiDrawElementsExt | null
}

type MultiDrawElementsExt = {
  multiDrawElementsWEBGL: (
    mode: number,
    counts: Int32Array,
    countsOffset: number,
    type: number,
    offsets: Int32Array,
    offsetsOffset: number,
    drawCount: number,
  ) => void
}

export type LegacyMultiDrawScratch = {
  counts: Int32Array
  offsets: Int32Array
}

export function createLegacyMultiDrawScratch (): LegacyMultiDrawScratch {
  return {
    counts: new Int32Array(MAX_OPAQUE_SPANS),
    offsets: new Int32Array(MAX_OPAQUE_SPANS),
  }
}

/** Grow scratch arrays when blend (uncapped) span count exceeds opaque cap. */
function ensureScratchCapacity (scratch: LegacyMultiDrawScratch, minLength: number): void {
  if (scratch.counts.length >= minLength) return
  let newLen = scratch.counts.length
  while (newLen < minLength) newLen *= 2
  scratch.counts = new Int32Array(newLen)
  scratch.offsets = new Int32Array(newLen)
}

export function detectLegacyMultiDrawCaps (gl: WebGL2RenderingContext): LegacyMultiDrawCaps {
  const ext = gl.getExtension('WEBGL_multi_draw')
  if (ext) {
    return { tier: 'A', ext: ext as MultiDrawElementsExt }
  }
  return { tier: 'B', ext: null }
}

let tierLogged = false

export function logLegacyMultiDrawTierOnce (tier: LegacyMultiDrawTier, debug: boolean): void {
  if (tierLogged || !debug) return
  tierLogged = true
  console.info('[globalLegacyBuffer] legacy multi_draw tier', tier)
}

/**
 * Issue indexed legacy draws for visible spans. Tier B/C loop drawElements.
 */
export function drawLegacySpans (
  gl: WebGL2RenderingContext,
  caps: LegacyMultiDrawCaps,
  spans: readonly LegacyDrawSpan[],
  scratch: LegacyMultiDrawScratch,
): void {
  const drawCount = spans.length
  if (drawCount === 0) return

  ensureScratchCapacity(scratch, drawCount)

  const mode = gl.TRIANGLES
  const type = gl.UNSIGNED_INT

  for (let i = 0; i < drawCount; i++) {
    const span = spans[i]!
    scratch.counts[i] = span.indexCount
    scratch.offsets[i] = span.indexStart * 4
  }

  if (caps.tier === 'A' && caps.ext) {
    caps.ext.multiDrawElementsWEBGL(
      mode,
      scratch.counts, 0,
      type,
      scratch.offsets, 0,
      drawCount,
    )
    return
  }

  for (let i = 0; i < drawCount; i++) {
    gl.drawElements(mode, scratch.counts[i]!, type, scratch.offsets[i]!)
  }
}
