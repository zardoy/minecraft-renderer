import { describe, expect, test } from 'vitest'
import { computeEatTransform, shouldApplyEatTransform, type EatTransformSession } from './holdingBlockEatTransform'

const session = (overrides: Partial<EatTransformSession> = {}): EatTransformSession => ({
  hand: 0,
  action: 'EAT',
  durationTicks: 32,
  elapsedTicks: 0,
  status: 'active',
  ...overrides
})

describe('computeEatTransform', () => {
  test('returns no offsets at h = 1', () => {
    const transform = computeEatTransform(1, 0)
    expect(transform.jiggleY).toBe(0)
    expect(transform.translation.x).toBe(0)
    expect(transform.translation.y).toBeCloseTo(0)
    expect(transform.translation.z).toBe(0)
    expect(transform.rotationDegrees).toEqual({ x: 0, y: 0, z: 0 })
  })

  test('returns the full offsets at h = 0', () => {
    const transform = computeEatTransform(0, 2)
    expect(transform.jiggleY).toBeCloseTo(0)
    expect(transform.translation).toEqual({ x: 0.6, y: -0.5, z: 0 })
    expect(transform.rotationDegrees).toEqual({ x: 10, y: 90, z: 30 })
  })

  test('disables jiggle at h >= 0.8', () => {
    expect(computeEatTransform(0.8, 0).jiggleY).toBe(0)
  })

  test('uses the vanilla jiggle formula below h = 0.8', () => {
    const h = 0.5
    const g = 1.25
    expect(computeEatTransform(h, g).jiggleY).toBeCloseTo(Math.abs(Math.cos((g / 4) * Math.PI) * 0.1))
  })
})

describe('shouldApplyEatTransform', () => {
  test('accepts active and awaiting EAT/DRINK sessions while remaining ticks are positive', () => {
    expect(shouldApplyEatTransform(session(), 0)).toBe(true)
    expect(shouldApplyEatTransform(session({ action: 'DRINK', status: 'awaitingCompletion', elapsedTicks: 8 }), 0)).toBe(true)
  })

  test.each([
    ['wrong hand', session({ hand: 1 }), 0],
    ['completed', session({ status: 'completed' }), 0],
    ['cancelled', session({ status: 'cancelled' }), 0],
    ['bow', session({ action: 'BOW' }), 0],
    ['zero duration', session({ durationTicks: 0 }), 0],
    ['remaining zero while awaiting', session({ status: 'awaitingCompletion', elapsedTicks: 32 }), 0],
    ['remaining zero while active', session({ elapsedTicks: 32 }), 0]
  ] as const)('rejects %s', (_reason, value, hand) => {
    expect(shouldApplyEatTransform(value, hand)).toBe(false)
  })

  test('rejects an absent session', () => {
    expect(shouldApplyEatTransform(undefined, 0)).toBe(false)
  })
})
