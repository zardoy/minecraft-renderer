import { describe, expect, it } from 'vitest'
import { AdaptiveResolution } from './adaptiveResolution'

/** feeds `seconds` of frames at a fixed interval; returns the scale after each change */
const run = (ar: AdaptiveResolution, state: { now: number }, seconds: number, intervalMs: number, cpuMs: number, base = 3) => {
  const changes: number[] = []
  const frames = Math.round((seconds * 1000) / intervalMs)
  for (let i = 0; i < frames; i++) {
    state.now += intervalMs
    if (ar.onFrame(state.now, intervalMs, cpuMs, base)) changes.push(ar.scale)
  }
  return changes
}

describe('AdaptiveResolution', () => {
  it('lowers the scale while GPU bound at 30 FPS, down to pixel ratio 1 at most', () => {
    const ar = new AdaptiveResolution()
    const state = { now: 0 }
    const changes = run(ar, state, 60, 33.3, 4)
    expect(changes.length).toBeGreaterThan(2)
    expect(ar.scale * 3).toBeGreaterThanOrEqual(1 - 1e-9)
    // spaced out: no two changes within the minimum interval
    expect(changes.length).toBeLessThanOrEqual(Math.ceil(60_000 / 2500))
  })

  it('does not lower the scale when the CPU is the limit', () => {
    const ar = new AdaptiveResolution()
    const state = { now: 0 }
    run(ar, state, 20, 33.3, 28)
    expect(ar.scale).toBe(1)
  })

  it('ignores windows with stalls (chunk loading, GC)', () => {
    const ar = new AdaptiveResolution({ windowFrames: 10 })
    let now = 0
    for (let i = 0; i < 200; i++) {
      const interval = i % 10 === 5 ? 250 : 33.3
      now += interval
      ar.onFrame(now, interval, 3, 3)
    }
    expect(ar.scale).toBe(1)
  })

  it('raises back when there is headroom and stops bouncing after a failed raise', () => {
    const ar = new AdaptiveResolution()
    const state = { now: 0 }
    run(ar, state, 10, 33.3, 4)
    const lowered = ar.scale
    expect(lowered).toBeLessThan(1)
    // headroom: 60 FPS steady, it should step back up
    run(ar, state, 10, 16.6, 4)
    expect(ar.scale).toBeGreaterThan(lowered)
    // a raise that struggles at once is undone and held as the ceiling
    const before = ar.scale
    const changes = run(ar, state, 3, 33.3, 4)
    expect(changes.length).toBeGreaterThan(0)
    expect(ar.scale).toBeLessThan(before)
  })

  it('stays at full scale on a pixel ratio 1 screen', () => {
    const ar = new AdaptiveResolution()
    const state = { now: 0 }
    run(ar, state, 30, 33.3, 4, 1)
    expect(ar.scale).toBe(1)
  })
})
