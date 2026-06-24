import { expect, test, vi } from 'vitest'
import { createLegacyMultiDrawScratch, detectLegacyMultiDrawCaps, drawLegacySpans } from '../legacyMultiDraw'

function makeMockGl(opts?: { multiDraw?: boolean }): WebGL2RenderingContext {
  const multiDrawElementsWEBGL = vi.fn()
  const drawElements = vi.fn()
  return {
    TRIANGLES: 0x0004,
    UNSIGNED_INT: 0x1405,
    getExtension: (name: string) => {
      if (opts?.multiDraw && name === 'WEBGL_multi_draw') {
        return { multiDrawElementsWEBGL }
      }
      return null
    },
    drawElements
  } as unknown as WebGL2RenderingContext
}

test('detectLegacyMultiDrawCaps: tier A when WEBGL_multi_draw is available', () => {
  const gl = makeMockGl({ multiDraw: true })
  const caps = detectLegacyMultiDrawCaps(gl)
  expect(caps.tier).toBe('A')
  expect(caps.ext).not.toBeNull()
})

test('detectLegacyMultiDrawCaps: tier B when extension is missing', () => {
  const gl = makeMockGl()
  const caps = detectLegacyMultiDrawCaps(gl)
  expect(caps.tier).toBe('B')
  expect(caps.ext).toBeNull()
})

test('drawLegacySpans: tier A uses multiDrawElementsWEBGL with byte offsets', () => {
  const gl = makeMockGl({ multiDraw: true })
  const caps = detectLegacyMultiDrawCaps(gl)
  const scratch = createLegacyMultiDrawScratch()
  const spans = [
    { indexStart: 12, indexCount: 6 },
    { indexStart: 30, indexCount: 12 }
  ]

  drawLegacySpans(gl, caps, spans, scratch)

  expect(scratch.counts[0]).toBe(6)
  expect(scratch.counts[1]).toBe(12)
  expect(scratch.offsets[0]).toBe(48)
  expect(scratch.offsets[1]).toBe(120)

  const ext = caps.ext as { multiDrawElementsWEBGL: ReturnType<typeof vi.fn> }
  expect(ext.multiDrawElementsWEBGL).toHaveBeenCalledTimes(1)
  expect(ext.multiDrawElementsWEBGL).toHaveBeenCalledWith(gl.TRIANGLES, scratch.counts, 0, gl.UNSIGNED_INT, scratch.offsets, 0, 2)
})

test('drawLegacySpans: tier B loops drawElements per span', () => {
  const gl = makeMockGl()
  const caps = detectLegacyMultiDrawCaps(gl)
  const scratch = createLegacyMultiDrawScratch()
  const spans = [{ indexStart: 4, indexCount: 6 }]

  drawLegacySpans(gl, caps, spans, scratch)

  expect((gl as unknown as { drawElements: ReturnType<typeof vi.fn> }).drawElements).toHaveBeenCalledWith(gl.TRIANGLES, 6, gl.UNSIGNED_INT, 16)
})

test('drawLegacySpans: grows scratch past MAX_OPAQUE_SPANS for uncapped blend sets', () => {
  const gl = makeMockGl({ multiDraw: true })
  const caps = detectLegacyMultiDrawCaps(gl)
  const scratch = createLegacyMultiDrawScratch()
  expect(scratch.counts.length).toBe(64)

  const spanCount = 70
  const spans = Array.from({ length: spanCount }, (_, i) => ({
    indexStart: i * 6,
    indexCount: 6
  }))

  drawLegacySpans(gl, caps, spans, scratch)

  expect(scratch.counts.length).toBeGreaterThanOrEqual(spanCount)
  expect(scratch.offsets.length).toBeGreaterThanOrEqual(spanCount)
  expect(scratch.counts[69]).toBe(6)
  expect(scratch.offsets[69]).toBe(69 * 6 * 4)

  const ext = caps.ext as { multiDrawElementsWEBGL: ReturnType<typeof vi.fn> }
  expect(ext.multiDrawElementsWEBGL).toHaveBeenCalledWith(gl.TRIANGLES, scratch.counts, 0, gl.UNSIGNED_INT, scratch.offsets, 0, spanCount)
})
