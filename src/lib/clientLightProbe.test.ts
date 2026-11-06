import { describe, it, expect } from 'vitest'
import { setClientLightProbePositions, isClientLightProbeBlock, isClientLightProbeSection } from './clientLightProbe'

describe('client light probe selection', () => {
  it('maps negative and boundary coordinates to section origins', () => {
    setClientLightProbePositions([[-1, 63, 16], [16, 64, 0]])
    expect(isClientLightProbeBlock(-1, 63, 16)).toBe(true)
    expect(isClientLightProbeSection('-16,48,16')).toBe(true)
    expect(isClientLightProbeSection('16,64,0')).toBe(true)
    expect(isClientLightProbeBlock(0, 63, 16)).toBe(false)
    setClientLightProbePositions([])
    expect(isClientLightProbeSection('-16,48,16')).toBe(false)
  })
  it('rejects invalid coordinates without changing the selection', () => {
    setClientLightProbePositions([[1, 2, 3]])
    expect(() => setClientLightProbePositions([[1.5, 2, 3]])).toThrow()
    expect(isClientLightProbeBlock(1, 2, 3)).toBe(true)
    setClientLightProbePositions([])
  })
})
