import { expect, test, vi } from 'vitest'
import { buildVisibleCubeSpans, MAX_CUBE_SPANS } from '../cubeDrawSpans'
import { createCubeMultiDrawScratch, detectMultiDrawCaps, drawCubeSpans } from '../cubeMultiDraw'
import { VERTICES_PER_FACE } from '../shaders/cubeBlockShader'

type MultiDrawArgs = [number, Int32Array, number, Int32Array, number, Int32Array, number, Int32Array, number, number]

function makeMockGl(opts?: { tier?: 'A' | 'B' }): WebGL2RenderingContext {
  const multiDrawArraysInstancedBaseInstanceWEBGL = vi.fn((...args: MultiDrawArgs) => {
    const [, firsts, , counts, , instanceCounts, , baseInstances, , drawCount] = args
    // WebGL raises INVALID_OPERATION and draws nothing when an argument array is shorter than drawCount.
    for (const array of [firsts, counts, instanceCounts, baseInstances]) {
      if (array.length < drawCount) throw new Error(`argument array of length ${array.length} for drawCount ${drawCount}`)
    }
  })
  const drawArraysInstancedBaseInstanceWEBGL = vi.fn()
  return {
    TRIANGLES: 0x0004,
    getExtension: (name: string) => {
      if (opts?.tier === 'A' && name === 'WEBGL_multi_draw_instanced_base_vertex_base_instance') {
        return { multiDrawArraysInstancedBaseInstanceWEBGL }
      }
      if (opts?.tier === 'B' && name === 'WEBGL_draw_instanced_base_vertex_base_instance') {
        return { drawArraysInstancedBaseInstanceWEBGL }
      }
      return null
    }
  } as unknown as WebGL2RenderingContext
}

/** Visible slots with a one-instance hole between each, so no two merge into one span. */
function scatteredSpans(count: number) {
  const slots = Array.from({ length: count }, (_, i) => ({ start: i * 3, count: 2 }))
  return buildVisibleCubeSpans(slots, count * 3)
}

test('drawCubeSpans: tier A submits one instanced draw per span', () => {
  const gl = makeMockGl({ tier: 'A' })
  const caps = detectMultiDrawCaps(gl)
  const scratch = createCubeMultiDrawScratch()
  const spans = [
    { start: 4, count: 2 },
    { start: 10, count: 5 }
  ]

  drawCubeSpans(gl, caps, spans, scratch)

  expect(Array.from(scratch.firsts.subarray(0, 2))).toEqual([0, 0])
  expect(Array.from(scratch.counts.subarray(0, 2))).toEqual([VERTICES_PER_FACE, VERTICES_PER_FACE])
  expect(Array.from(scratch.instanceCounts.subarray(0, 2))).toEqual([2, 5])
  expect(Array.from(scratch.baseInstances.subarray(0, 2))).toEqual([4, 10])

  const ext = caps.ext as { multiDrawArraysInstancedBaseInstanceWEBGL: ReturnType<typeof vi.fn> }
  expect(ext.multiDrawArraysInstancedBaseInstanceWEBGL).toHaveBeenCalledTimes(1)
  expect(ext.multiDrawArraysInstancedBaseInstanceWEBGL).toHaveBeenCalledWith(
    gl.TRIANGLES,
    scratch.firsts,
    0,
    scratch.counts,
    0,
    scratch.instanceCounts,
    0,
    scratch.baseInstances,
    0,
    2
  )
})

test('drawCubeSpans: tier A grows scratch past MAX_CUBE_SPANS for fragmented visible sets', () => {
  const gl = makeMockGl({ tier: 'A' })
  const caps = detectMultiDrawCaps(gl)
  const scratch = createCubeMultiDrawScratch()
  expect(scratch.counts.length).toBe(MAX_CUBE_SPANS)

  const spans = scatteredSpans(MAX_CUBE_SPANS + 6)
  expect(spans.length).toBe(MAX_CUBE_SPANS + 6)

  drawCubeSpans(gl, caps, spans, scratch)

  for (const array of [scratch.firsts, scratch.counts, scratch.instanceCounts, scratch.baseInstances]) {
    expect(array.length).toBeGreaterThanOrEqual(spans.length)
  }
  const last = spans.length - 1
  expect(scratch.instanceCounts[last]).toBe(spans[last]!.count)
  expect(scratch.baseInstances[last]).toBe(spans[last]!.start)
  const ext = caps.ext as { multiDrawArraysInstancedBaseInstanceWEBGL: ReturnType<typeof vi.fn> }
  expect(ext.multiDrawArraysInstancedBaseInstanceWEBGL.mock.calls[0]![9]).toBe(spans.length)
})

test('drawCubeSpans: tier A keeps grown scratch when the visible set shrinks and grows again', () => {
  const gl = makeMockGl({ tier: 'A' })
  const caps = detectMultiDrawCaps(gl)
  const scratch = createCubeMultiDrawScratch()

  drawCubeSpans(gl, caps, scatteredSpans(MAX_CUBE_SPANS + 1), scratch)
  const grown = scratch.counts
  drawCubeSpans(gl, caps, scatteredSpans(3), scratch)
  expect(scratch.counts).toBe(grown)
  drawCubeSpans(gl, caps, scatteredSpans(grown.length * 2 + 1), scratch)

  expect(scratch.counts.length).toBeGreaterThanOrEqual(grown.length * 2 + 1)
  const ext = caps.ext as { multiDrawArraysInstancedBaseInstanceWEBGL: ReturnType<typeof vi.fn> }
  expect(ext.multiDrawArraysInstancedBaseInstanceWEBGL).toHaveBeenCalledTimes(3)
})

test('drawCubeSpans: tier B issues one base-instance draw per span', () => {
  const gl = makeMockGl({ tier: 'B' })
  const caps = detectMultiDrawCaps(gl)
  const scratch = createCubeMultiDrawScratch()
  const spans = scatteredSpans(MAX_CUBE_SPANS + 1)

  drawCubeSpans(gl, caps, spans, scratch)

  const ext = caps.ext as { drawArraysInstancedBaseInstanceWEBGL: ReturnType<typeof vi.fn> }
  expect(ext.drawArraysInstancedBaseInstanceWEBGL).toHaveBeenCalledTimes(spans.length)
  expect(ext.drawArraysInstancedBaseInstanceWEBGL).toHaveBeenLastCalledWith(gl.TRIANGLES, 0, VERTICES_PER_FACE, 2, (spans.length - 1) * 3)
})
