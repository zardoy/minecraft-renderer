import { describe, expect, it } from 'vitest'
import { isWeakMobileGpu, weakGpuDefaults } from './gpuTier'

describe('isWeakMobileGpu', () => {
  it.each([
    'ANGLE (ARM, Mali-G57, OpenGL ES 3.2)',
    'Mali-G52 MC2',
    'Mali-G76 MP10',
    'Mali-T880',
    'Mali-400 MP',
    'Adreno (TM) 610',
    'Adreno (TM) 618',
    'ANGLE (Qualcomm, Adreno (TM) 506, OpenGL ES 3.2)',
    'PowerVR Rogue GE8320',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)'
  ])('weak: %s', renderer => {
    expect(isWeakMobileGpu(renderer)).toBe(true)
  })

  it.each([
    'ANGLE (ARM, Mali-G78 MP24, OpenGL ES 3.2)',
    'Mali-G715-Immortalis MC11',
    'Immortalis-G720',
    'Adreno (TM) 640',
    'Adreno (TM) 740',
    'Apple GPU',
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    '',
    undefined
  ])('not weak: %s', renderer => {
    expect(isWeakMobileGpu(renderer)).toBe(false)
  })
})

describe('weakGpuDefaults', () => {
  it('turns shadows and color grading off and uses one mesher worker only for weak GPUs', () => {
    expect(weakGpuDefaults(true)).toEqual({ sunShadows: 'off', colorGrading: 'off', rendererWorldPerformance: 'low-energy' })
    expect(weakGpuDefaults(false)).toEqual({ sunShadows: 'normal', colorGrading: 'warm', rendererWorldPerformance: 'normal' })
  })
})
