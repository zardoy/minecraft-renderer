import { describe, expect, it } from 'vitest'
import { sanitizeForWorkerPostMessage } from './workerMessageSanitize'

describe('sanitizeForWorkerPostMessage', () => {
  it('drops functions such as debug loggers', () => {
    const debug = Object.assign(() => {}, { enabled: false })
    const entity = { id: 1, name: 'zombie', debug, position: { x: 1, y: 2, z: 3 } }
    const sanitized = sanitizeForWorkerPostMessage(entity) as Record<string, unknown>
    expect(sanitized.debug).toBeUndefined()
    expect(sanitized.id).toBe(1)
    expect(() => structuredClone(sanitized)).not.toThrow()
  })
})
