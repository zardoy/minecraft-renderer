import { describe, expect, it } from 'vitest'
import { SectionFade } from '../sectionFade'
import { BlockEffects } from '../blockEffects'
import { SECTION_FADE_RING, SECTION_FADE_Y } from '../shaders/sectionFadeGlsl'

const startOf = (fade: SectionFade, key: string) => {
  const index = fade.componentIndex(key)
  return index === undefined ? undefined : (fade.texture.image.data as Float32Array)[index]
}

describe('section fade start times', () => {
  it('addresses sections like the shader: x / z modulo the ring (negative too), y from the world bottom, 4 per texel', () => {
    const fade = new SectionFade()
    fade.setMinSectionY(-64)
    // section (0, -4, 0) is the first component, (1, -4, 0) the next one in the same texel
    expect(fade.componentIndex('0,-64,0')).toBe(0)
    expect(fade.componentIndex('16,-64,0')).toBe(1)
    expect(fade.componentIndex('64,-64,0')).toBe(4)
    // -16 is section -1 = ring index 63 (GLSL `& 63`)
    expect(fade.componentIndex('-16,-64,0')).toBe(fade.componentIndex(`${(SECTION_FADE_RING - 1) * 16},-64,0`))
    expect(fade.componentIndex('0,-80,0')).toBeUndefined()
    expect(fade.componentIndex(`0,${-64 + SECTION_FADE_Y * 16},0`)).toBeUndefined()
  })

  it('a section fades once per load: shown again (remesh) keeps its start, unloaded and shown again restarts', () => {
    const fade = new SectionFade()
    fade.sectionShown('32,64,48', 1000)
    const first = startOf(fade, '32,64,48')!
    expect(first).toBeGreaterThan(0)
    fade.sectionShown('32,64,48', 5000)
    expect(startOf(fade, '32,64,48')).toBe(first)
    fade.sectionForgotten('32,64,48')
    fade.sectionShown('32,64,48', 5000)
    expect(startOf(fade, '32,64,48')).toBeGreaterThan(first)
  })

  it('a reset clears every start time', () => {
    const fade = new SectionFade()
    fade.sectionShown('0,0,0')
    fade.reset()
    expect(startOf(fade, '0,0,0')).toBe(0)
  })
})

describe('BlockEffects section fade switch', () => {
  it('only marks sections while on; 0 s turns it off', () => {
    const effects = new BlockEffects()
    effects.setSectionFade('fade', 0)
    expect(effects.getSectionFadeMode()).toBe('off')
    effects.setSectionFade('fade', 0.75)
    expect(effects.getSectionFadeMode()).toBe('fade')
    effects.sectionShown('0,0,0')
    expect(startOf(effects.sectionFade!, '0,0,0')).toBeGreaterThan(0)
    effects.setSectionFade('scifi', 1.4)
    expect(effects.getSectionFadeMode()).toBe('scifi')
    expect(effects.uniforms.u_sectionFadeTex.value).toBe(effects.sectionFade!.texture)
  })
})
