import { describe, expect, test } from 'vitest'
import { SectionRequestTracker } from '../worker/mesherWasmRequestTracker'

describe('SectionRequestTracker.clearColumn', () => {
  test('removes all pending keys for the column', () => {
    const tracker = new SectionRequestTracker()
    tracker.addRequest('160,64,0')
    tracker.addRequest('160,80,0')
    tracker.addRequest('0,64,0')

    tracker.clearColumn(160, 0)

    expect(tracker.hasPending('160,64,0')).toBe(false)
    expect(tracker.hasPending('160,80,0')).toBe(false)
    expect(tracker.hasPending('0,64,0')).toBe(true)
    expect(tracker.size()).toBe(1)
  })

  test('is a no-op when the column has no pending keys', () => {
    const tracker = new SectionRequestTracker()
    tracker.addRequest('0,64,0')

    tracker.clearColumn(160, 0)

    expect(tracker.hasPending('0,64,0')).toBe(true)
    expect(tracker.size()).toBe(1)
  })
})
