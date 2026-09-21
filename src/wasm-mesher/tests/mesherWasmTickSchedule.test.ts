import { describe, expect, test, vi } from 'vitest'
import { BULK_MESH_INTERVAL_MS, createMeshTickScheduler } from '../worker/mesherWasmTickSchedule'

describe('createMeshTickScheduler', () => {
  test('an urgent kick runs on the next turn, before the bulk poll interval', async () => {
    vi.useFakeTimers()
    try {
      let runs = 0
      const scheduler = createMeshTickScheduler(() => {
        runs++
      })
      scheduler.kick()
      expect(runs).toBe(0)
      await vi.advanceTimersByTimeAsync(0)
      expect(runs).toBe(1)
      expect(BULK_MESH_INTERVAL_MS).toBeGreaterThan(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test('a kick during a running tick runs again after that tick finishes', async () => {
    vi.useFakeTimers()
    try {
      let release: () => void = () => {}
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      let runs = 0
      const scheduler = createMeshTickScheduler(() => {
        runs++
        if (runs === 1) {
          scheduler.kick()
          return gate
        }
      })
      scheduler.kick()
      await vi.advanceTimersByTimeAsync(0)
      expect(runs).toBe(1)
      release()
      await gate
      await Promise.resolve()
      expect(runs).toBe(2)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
