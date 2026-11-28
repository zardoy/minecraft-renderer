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
    fade.columnForgotten(32, 48)
    fade.sectionShown('32,64,48', 5000)
    expect(startOf(fade, '32,64,48')).toBeGreaterThan(first)
  })

  it('a section shown by a block change (first mesh behind a broken block) is drawn fully at once, a later remesh does not fade it', () => {
    const fade = new SectionFade()
    fade.sectionShown('32,64,48', 1000)
    // the column finished fading long ago; the solid section below had no mesh until a block next to it was broken
    fade.sectionShownWithoutFade('32,48,48')
    expect(startOf(fade, '32,48,48')).toBe(0)
    fade.sectionShown('32,48,48', 60_000)
    expect(startOf(fade, '32,48,48')).toBe(0)
  })

  it('a column is revealed at once: a section shown later takes the column start, an unloaded column starts over', () => {
    const fade = new SectionFade()
    fade.sectionShown('32,64,48', 1000)
    fade.sectionShown('32,80,48', 1000)
    // a section of the same column that gets its first mesh while the column is still fading joins it in sync
    fade.sectionShown('32,48,48', 1400)
    expect(startOf(fade, '32,48,48')).toBe(startOf(fade, '32,64,48'))
    // another column: its own start
    fade.sectionShown('48,64,48', 4000)
    expect(startOf(fade, '48,64,48')).toBeGreaterThan(startOf(fade, '32,64,48')!)
    // column unloaded and loaded again: fades again
    fade.sectionForgotten('32,64,48')
    fade.columnForgotten(32, 48)
    fade.sectionShown('32,64,48', 9000)
    expect(startOf(fade, '32,64,48')).toBeGreaterThan(startOf(fade, '32,80,48')!)
  })

  it('a section arriving after its column finished fades on its own (dissolve), or shows fully (futuristic look)', () => {
    const fade = new SectionFade()
    fade.durationSec = 0.75
    fade.sectionShown('32,64,48', 1000)
    const columnStart = startOf(fade, '32,64,48')!
    // 0.5 s later: still fading, joins in sync
    fade.sectionShown('32,80,48', 1500)
    expect(startOf(fade, '32,80,48')).toBe(columnStart)
    // 2 s later the column is done: fades on its own, and a section right after joins that new start
    fade.sectionShown('32,48,48', 3000)
    expect(startOf(fade, '32,48,48')).toBeCloseTo(columnStart + 2, 5)
    fade.sectionShown('32,32,48', 3100)
    expect(startOf(fade, '32,32,48')).toBe(startOf(fade, '32,48,48'))
    // already shown sections keep their start
    expect(startOf(fade, '32,64,48')).toBe(columnStart)

    const scifi = new SectionFade()
    scifi.lateSectionsFadeAlone = false
    scifi.sectionShown('32,64,48', 1000)
    scifi.sectionShown('32,48,48', 3000)
    expect(startOf(scifi, '32,48,48')).toBe(startOf(scifi, '32,64,48'))
  })

  it('a reset clears every start time', () => {
    const fade = new SectionFade()
    fade.sectionShown('0,0,0')
    fade.reset()
    expect(startOf(fade, '0,0,0')).toBe(0)
  })
})

describe('BlockEffects section fade switch', () => {
  it('reports the plain fade left for the fade pass: not in the camera column, not when done, not for the futuristic look', () => {
    const effects = new BlockEffects()
    effects.setSectionFade('fade', 0.75)
    const now = performance.now()
    effects.sectionFade!.sectionShown('32,64,48', now)
    // camera 40 blocks away: fading for the whole duration
    expect(effects.sectionFadeRemaining('32,64,48', 0, 0, now)).toBeCloseTo(0.75, 2)
    expect(effects.sectionFadeRemaining('32,64,48', 0, 0, now + 500)).toBeCloseTo(0.25, 2)
    expect(effects.sectionFadeRemaining('32,64,48', 0, 0, now + 800)).toBe(0)
    // camera in that column (centre 40,56): drawn normally
    expect(effects.sectionFadeRemaining('32,64,48', 41, 57, now)).toBe(0)
    // a section never shown
    expect(effects.sectionFadeRemaining('96,64,48', 0, 0, now)).toBe(0)
    effects.setSectionFade('scifi', 1.4)
    expect(effects.sectionFadeRemaining('32,64,48', 0, 0, now)).toBe(0)
  })

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
