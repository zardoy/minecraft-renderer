import { describe, expect, it } from 'vitest'
import { SmoothTimeOfDay, tickDelta } from '../smoothTimeOfDay'

/** Packets like a real server: every 1000 ms, +20 ticks. */
function run(start: number, packets: number, step = 20, intervalMs = 1000) {
  const t = new SmoothTimeOfDay()
  let now = 10_000
  for (let i = 0; i < packets; i++) {
    t.update(start + i * step, now)
    now += intervalMs
  }
  return { t, lastPacketAt: now - intervalMs }
}

describe('tickDelta', () => {
  it('is the shortest signed distance on the 24000 tick clock', () => {
    expect(tickDelta(10, 5)).toBe(5)
    expect(tickDelta(5, 10)).toBe(-5)
    expect(tickDelta(10, 23_990)).toBe(20)
    expect(tickDelta(23_990, 10)).toBe(-20)
  })
})

describe('SmoothTimeOfDay', () => {
  it('advances continuously between packets at the measured rate', () => {
    const { t, lastPacketAt } = run(6000, 6)
    expect(t.ticksPerSecond).toBeCloseTo(20, 0)
    const last = 6000 + 5 * 20
    // 40 ticks of the day move smoothly across one second, not in one jump
    const samples = [0, 250, 500, 750, 1000].map(ms => t.get(lastPacketAt + ms) - last)
    for (let i = 1; i < samples.length; i++) expect(samples[i]! - samples[i - 1]!).toBeCloseTo(5, 0)
  })

  it('every step is much smaller than one packet (what makes shadows stop jumping)', () => {
    const { t, lastPacketAt } = run(4000, 8)
    let maxStep = 0
    let previous = t.get(lastPacketAt)
    for (let ms = 16; ms <= 1000; ms += 16) {
      const now = t.get(lastPacketAt + ms)
      maxStep = Math.max(maxStep, now - previous)
      previous = now
    }
    expect(maxStep).toBeLessThan(1.2) // ticks per 16 ms frame at 20 ticks/s is 0.32, a packet step is 20
  })

  it('does not drift when time is frozen', () => {
    const { t, lastPacketAt } = run(6000, 6, 0)
    expect(t.ticksPerSecond).toBe(0)
    expect(t.get(lastPacketAt + 1500)).toBeCloseTo(6000, 5)
  })

  it('blends a late or early packet in instead of snapping back', () => {
    const { t, lastPacketAt } = run(6000, 6)
    const nowAtNext = lastPacketAt + 1000
    const before = t.get(nowAtNext)
    // the next packet arrives 80 ms late, so the prediction ran ahead of it
    t.update(6000 + 6 * 20, nowAtNext + 80)
    const after = t.get(nowAtNext + 80)
    expect(Math.abs(after - t.get(nowAtNext + 80 - 1))).toBeLessThan(1)
    expect(after).toBeGreaterThanOrEqual(before)
    // and it ends up on the packet's timeline (a late packet lowers the measured rate a little: ~1 tick = 0.015 degrees)
    expect(Math.abs(t.get(nowAtNext + 80 + 1000) - (6000 + 6 * 20 + 20))).toBeLessThan(1.5)
  })

  it('takes a time change (/time set, sleeping) over immediately', () => {
    const { t, lastPacketAt } = run(6000, 6)
    t.update(18_000, lastPacketAt + 1000)
    expect(t.get(lastPacketAt + 1000)).toBeCloseTo(18_000, 3)
  })

  it('wraps over midnight', () => {
    const { t, lastPacketAt } = run(23_920, 5)
    const wrapped = t.get(lastPacketAt + 1000)
    expect(wrapped).toBeGreaterThanOrEqual(0)
    expect(wrapped).toBeLessThan(DAY)
    expect(t.get(lastPacketAt + 3000)).toBeLessThan(200) // 23_920 + 80 + 60 -> past the wrap
  })

  it('stops extrapolating when packets stop (lag spike, paused game)', () => {
    const { t, lastPacketAt } = run(6000, 6)
    expect(t.get(lastPacketAt + 60_000)).toBeCloseTo(t.get(lastPacketAt + 2500), 5)
  })

  it('ignores garbage', () => {
    const t = new SmoothTimeOfDay()
    t.update(Number.NaN, 0)
    expect(t.get(0)).toBe(0)
    t.update(5000, 0)
    t.update(Number.NaN, 1000)
    expect(t.get(0)).toBe(5000)
  })
})

const DAY = 24_000
