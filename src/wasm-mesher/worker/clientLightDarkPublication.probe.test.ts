import { describe, it, expect } from 'vitest'
import { applyOwnerPublicationToColumnCaches } from './mesherWasmOwnerLight'
import { displayLightColumn } from './mesherWasmLightMerge'

describe('dark publication omission diagnostic (current behavior)', () => {
  const blockOnly = { sx: 0, sy: 0, sz: 0, blockLight: new Uint8Array(2048) }
  const base = { worldMinY: 0, columnWorldX: 0, columnWorldZ: 0, numSections: 2 }
  it('displays sky 15 when initial publication omits sky and no incoming light exists', () => {
    const result = applyOwnerPublicationToColumnCaches({ ...base, incoming: undefined, display: undefined, sections: [blockOnly] })
    expect(displayLightColumn(result.display, 'sky').subarray(0, 4096).every(value => value === 15)).toBe(true)
  })
  it('retains dark sky when an incoming authoritative cache exists', () => {
    const initial = applyOwnerPublicationToColumnCaches({ ...base, incoming: undefined, display: undefined, sections: [{ ...blockOnly, skyLight: new Uint8Array(2048) }] }).display
    const result = applyOwnerPublicationToColumnCaches({ ...base, incoming: initial, display: initial, sections: [blockOnly] })
    expect(displayLightColumn(result.display, 'sky').subarray(0, 4096).every(value => value === 0)).toBe(true)
    expect(result.display).not.toBe(initial)
  })
})
