import {
  assertDrawSpansWithinLiveRanges,
  carveSpansAroundPendingRanges,
  FULL_DRAW_VISIBLE_FRACTION,
  MAX_OPAQUE_SPANS,
  type DirtyRange,
} from './globalLegacyBuffer'

export { FULL_DRAW_VISIBLE_FRACTION, MAX_OPAQUE_SPANS as MAX_CUBE_SPANS }

export type CubeDrawSpan = { start: number, count: number }

export type VisibleCubeSlot = { start: number, count: number }

/** Merge only physically adjacent face ranges (gap === 0). Never bridge interior holes. */
function mergeCubeSpans (spans: CubeDrawSpan[]): void {
  if (spans.length < 2) return
  let i = 0
  while (i < spans.length - 1) {
    const cur = spans[i]!
    const next = spans[i + 1]!
    if (cur.start + cur.count === next.start) {
      cur.count = next.start + next.count - cur.start
      spans.splice(i + 1, 1)
    } else {
      i++
    }
  }
}

/**
 * Merge visible face-instance ranges for WEBGL_multi_draw (option B).
 * Instance indices — no *6 scaling on span values.
 */
export function buildVisibleCubeSpans (
  visibleSlots: VisibleCubeSlot[],
  highWatermark: number,
  canFullDraw = true,
  _isRangeUploaded?: (start: number, end: number) => boolean,
  pendingRanges: ReadonlyArray<DirtyRange> = [],
): CubeDrawSpan[] {
  if (visibleSlots.length === 0 || highWatermark === 0) return []

  let visibleFaceCount = 0
  for (const slot of visibleSlots) {
    visibleFaceCount += slot.count
  }

  let spans: CubeDrawSpan[]
  const usedFullDraw = canFullDraw && visibleFaceCount >= highWatermark * FULL_DRAW_VISIBLE_FRACTION
  if (usedFullDraw) {
    spans = [{ start: 0, count: highWatermark }]
  } else {
    spans = visibleSlots.map(s => ({ start: s.start, count: s.count }))
    spans.sort((a, b) => a.start - b.start)
    const liveDrawRanges = spans.map(s => ({ ...s }))
    mergeCubeSpans(spans)
    spans = carveSpansAroundPendingRanges(spans, pendingRanges)
    assertDrawSpansWithinLiveRanges(spans, liveDrawRanges, 'globalBlockBuffer')
    return spans
  }
  return carveSpansAroundPendingRanges(spans, pendingRanges)
}
