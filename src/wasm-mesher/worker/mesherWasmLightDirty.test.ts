import { describe, expect, it } from 'vitest'
import { dropRawMapChunkOnLightOnlyReload, sectionYsForLightColumnDirty } from './mesherWasmLightDirty'

describe('sectionYsForLightColumnDirty', () => {
  it('covers every section in a 256-high overworld column', () => {
    expect(sectionYsForLightColumnDirty(0, 256)).toEqual(Array.from({ length: 16 }, (_, i) => i * 16))
  })
})

describe('dropRawMapChunkOnLightOnlyReload', () => {
  it('deletes only the fused raw entry when the chunk reload is light-only', () => {
    const raw = new Map<string, number>([
      ['0,0', 1],
      ['16,0', 2]
    ])
    expect(dropRawMapChunkOnLightOnlyReload(false, raw, '0,0')).toBe(false)
    expect(raw.has('0,0')).toBe(true)
    expect(dropRawMapChunkOnLightOnlyReload(undefined, raw, '0,0')).toBe(false)
    expect(raw.has('0,0')).toBe(true)
    expect(dropRawMapChunkOnLightOnlyReload(true, raw, '0,0')).toBe(true)
    expect(raw.has('0,0')).toBe(false)
    expect(raw.has('16,0')).toBe(true)
  })
})
