import { describe, expect, test } from 'vitest'
import { buildVisibleCubeSpans, MAX_CUBE_SPANS, SPAN_GAP_TOLERANCE_FACES } from '../cubeDrawSpans'

describe('buildVisibleCubeSpans', () => {
  test('contiguous slots merge into one span', () => {
    const spans = buildVisibleCubeSpans(
      [
        { start: 0, count: 4 },
        { start: 4, count: 2 }
      ],
      6
    )
    expect(spans.length).toBe(1)
    expect(spans[0]).toEqual({ start: 0, count: 6 })
  })

  test('scattered slots stay as multiple spans', () => {
    const gap = SPAN_GAP_TOLERANCE_FACES + 1
    const spans = buildVisibleCubeSpans(
      [
        { start: 0, count: 1 },
        { start: 1 + gap, count: 1 }
      ],
      1 + gap + 1
    )
    expect(spans.length).toBe(2)
    expect(spans[0]).toEqual({ start: 0, count: 1 })
    expect(spans[1]).toEqual({ start: 1 + gap, count: 1 })
  })

  test('full draw when most faces visible', () => {
    const spans = buildVisibleCubeSpans(
      [
        { start: 0, count: 3 },
        { start: 3, count: 3 },
        { start: 6, count: 2 }
      ],
      8
    )
    expect(spans.length).toBe(1)
    expect(spans[0]).toEqual({ start: 0, count: 8 })
  })

  test('caps at MAX_CUBE_SPANS with full coverage', () => {
    const visibleSectionCount = MAX_CUBE_SPANS + 5
    const padFaces = SPAN_GAP_TOLERANCE_FACES + 1
    const visibleSlots: Array<{ start: number; count: number }> = []
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
    expect(spans.length).toBe(MAX_CUBE_SPANS)

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
