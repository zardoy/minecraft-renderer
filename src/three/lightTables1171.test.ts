import { describe, expect, it } from 'vitest'
import { buildLightTables1171 } from './lightTables1171'

describe('buildLightTables1171', () => {
  it('builds 1.17.1 state tables from minecraft-data without claiming a vanilla dump', () => {
    const tables = buildLightTables1171()
    expect(tables.version).toBe('1.17.1')
    expect(tables.source).toBe('minecraft-data-block-level')
    expect(tables.vanillaRegistryComplete).toBe(false)
    expect(tables.emission.length).toBeGreaterThan(1491)
    expect(tables.emission[1491]).toBe(14)
    expect(tables.opacity[1491]).toBeGreaterThanOrEqual(1)
    expect(tables.emission[3430]).toBe(0)
    expect(tables.emission[5361]).toBe(0)
  })
})
