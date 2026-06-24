import { describe, expect, it } from 'vitest'
import { sectionYsForLightColumnDirty } from './mesherWasmLightDirty'

describe('sectionYsForLightColumnDirty', () => {
  it('covers every section in a 256-high overworld column', () => {
    expect(sectionYsForLightColumnDirty(0, 256)).toEqual(Array.from({ length: 16 }, (_, i) => i * 16))
  })
})
