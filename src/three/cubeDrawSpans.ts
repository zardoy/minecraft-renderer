import {
  FULL_DRAW_VISIBLE_FRACTION,
  MAX_OPAQUE_SPANS,
  SPAN_GAP_TOLERANCE_QUADS,
} from './globalLegacyBuffer'

export const MAX_CUBE_SPANS = MAX_OPAQUE_SPANS
export const SPAN_GAP_TOLERANCE_FACES = SPAN_GAP_TOLERANCE_QUADS
export { FULL_DRAW_VISIBLE_FRACTION }

export type CubeDrawSpan = { start: number, count: number }

export type VisibleCubeSlot = { start: number, count: number }

function mergeCubeSpans (spans: CubeDrawSpan[]): void {
  if (spans.length < 2) return
  let i = 0
  while (i < spans.length - 1) {
    const cur = spans[i]!
    const next = spans[i + 1]!
    const gap = next.start - (cur.start + cur.count)
    if (gap <= SPAN_GAP_TOLERANCE_FACES) {
      cur.count = next.start + next.count - cur.start
      spans.splice(i + 1, 1)
    } else {
      i++
    }
  }
}

function capCubeSpans (spans: CubeDrawSpan[]): void {
  while (spans.length > MAX_CUBE_SPANS) {
    let bestIdx = 0
    let bestGap = Infinity
    for (let i = 0; i < spans.length - 1; i++) {
      const gap = spans[i + 1]!.start - (spans[i]!.start + spans[i]!.count)
      if (gap < bestGap) {
        bestGap = gap
        bestIdx = i
      }
    }
    const cur = spans[bestIdx]!
    const next = spans[bestIdx + 1]!
    cur.count = next.start + next.count - cur.start
    spans.splice(bestIdx + 1, 1)
  }
}

/**
 * Merge/cap visible face-instance ranges for WEBGL_multi_draw (option B).
 * Instance indices — no *6 scaling on span values.
 */
export function buildVisibleCubeSpans (
  visibleSlots: VisibleCubeSlot[],
  highWatermark: number,
): CubeDrawSpan[] {
  if (visibleSlots.length === 0 || highWatermark === 0) return []

  let visibleFaceCount = 0
  for (const slot of visibleSlots) {
    visibleFaceCount += slot.count
  }

  if (visibleFaceCount >= highWatermark * FULL_DRAW_VISIBLE_FRACTION) {
    return [{ start: 0, count: highWatermark }]
  }

  const spans = visibleSlots.map(s => ({ start: s.start, count: s.count }))
  spans.sort((a, b) => a.start - b.start)
  mergeCubeSpans(spans)
  capCubeSpans(spans)
  return spans
}
