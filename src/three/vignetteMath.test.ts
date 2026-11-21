import { describe, expect, it } from 'vitest'
import { easeVignette, lightBrightness, rawLightAtEyes, vignetteTarget } from './vignetteMath'

describe('vanilla vignette', () => {
  it('has no vignette in full light and full vignette in the dark, following the light curve', () => {
    expect(vignetteTarget(15)).toBe(0)
    expect(vignetteTarget(0)).toBe(1)
    expect(lightBrightness(7.5)).toBeCloseTo(0.2, 2)
    expect(vignetteTarget(12)).toBeCloseTo(0.5, 2) // 0.8 / (4 - 2.4)
    expect(vignetteTarget(undefined)).toBe(0)
  })

  it('darkens the sky light at night before comparing it with block light', () => {
    expect(rawLightAtEyes(0, 15, 15)).toBe(15) // noon
    expect(rawLightAtEyes(0, 15, 4)).toBe(4) // midnight: skyDarken 11
    expect(rawLightAtEyes(10, 15, 4)).toBe(10) // a torch beats the night sky
    expect(rawLightAtEyes(undefined, undefined, 15)).toBeUndefined()
  })

  it('eases 1 % per 50 ms tick, independent of the frame rate', () => {
    expect(easeVignette(0, 1, 50)).toBeCloseTo(0.01, 5)
    let fine = 0
    for (let i = 0; i < 100; i++) fine = easeVignette(fine, 1, 10)
    expect(fine).toBeCloseTo(easeVignette(0, 1, 1000), 5)
    expect(easeVignette(0.5, 1, 0)).toBe(0.5)
  })
})
