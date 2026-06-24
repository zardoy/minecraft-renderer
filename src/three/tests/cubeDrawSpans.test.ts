import { describe, expect, test } from 'vitest'
import { buildVisibleCubeSpans } from '../cubeDrawSpans'

describe('buildVisibleCubeSpans', () => {
  test('contiguous slots merge into one span', () => {
    const spans = buildVisibleCubeSpans([
      { start: 0, count: 4 },
      { start: 4, count: 2 },
    ], 6)
    expect(spans.length).toBe(1)
    expect(spans[0]).toEqual({ start: 0, count: 6 })
  })

  test('scattered slots stay as multiple spans', () => {
    const spans = buildVisibleCubeSpans([
      { start: 0, count: 1 },
      { start: 10, count: 1 },
    ], 11)
    expect(spans.length).toBe(2)
    expect(spans[0]).toEqual({ start: 0, count: 1 })
    expect(spans[1]).toEqual({ start: 10, count: 1 })
  })

  test('full draw when most faces visible', () => {
    const spans = buildVisibleCubeSpans([
      { start: 0, count: 3 },
      { start: 3, count: 3 },
      { start: 6, count: 2 },
    ], 8)
    expect(spans.length).toBe(1)
    expect(spans[0]).toEqual({ start: 0, count: 8 })
  })

  test('full draw blocked when canFullDraw is false', () => {
    const spans = buildVisibleCubeSpans([{ start: 0, count: 6 }], 8, false)
    expect(spans).toEqual([{ start: 0, count: 6 }])
  })

  test('carves pending interior range from full-draw span', () => {
    const spans = buildVisibleCubeSpans(
      [{ start: 0, count: 6 }],
      8,
      true,
      undefined,
      [{ start: 2, end: 3 }],
    )
    expect(spans).toEqual([
      { start: 0, count: 2 },
      { start: 4, count: 4 },
    ])
  })

  test('does not merge across interior gap', () => {
    const spans = buildVisibleCubeSpans([
      { start: 0, count: 1 },
      { start: 2, count: 1 },
    ], 3)
    expect(spans.length).toBe(2)
    expect(spans[0]).toEqual({ start: 0, count: 1 })
    expect(spans[1]).toEqual({ start: 2, count: 1 })
  })

  test('does not cap span count when many scattered sections', () => {
    const visibleSectionCount = 69
    const padFaces = 10
    const visibleSlots: Array<{ start: number, count: number }> = []
    let cursor = 0

    for (let i = 0; i < visibleSectionCount; i++) {
      visibleSlots.push({ start: cursor, count: 1 })
      cursor += 1
      if (i < visibleSectionCount - 1) {
        cursor += padFaces
      }
    }

    const highWatermark = cursor
    const spans = buildVisibleCubeSpans(visibleSlots, highWatermark)
    expect(spans.length).toBe(visibleSectionCount)

    const covered = new Set<number>()
    for (const span of spans) {
      for (let f = span.start; f < span.start + span.count; f++) {
        covered.add(f)
      }
    }
    for (const slot of visibleSlots) {
      expect(covered.has(slot.start)).toBe(true)
    }
  })

  test('empty input returns empty spans', () => {
    expect(buildVisibleCubeSpans([], 10)).toEqual([])
    expect(buildVisibleCubeSpans([{ start: 0, count: 1 }], 0)).toEqual([])
  })
})
