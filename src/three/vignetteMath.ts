/**
 * Vanilla's vignette (Hud.extractVignette / updateVignetteBrightness): it is not a constant edge darkening. Its strength is how dark it
 * is around the camera, `1 - brightness(light level at the eyes)`, eased towards its target by 1 % every game tick (50 ms).
 * In full daylight it is gone, in a cave or at night it is at full strength.
 */

/** Vanilla `Lightmap.getBrightness` for the overworld (ambient light 0): the light curve, 0..1. */
export function lightBrightness(lightLevel: number): number {
  const v = Math.min(15, Math.max(0, lightLevel)) / 15
  return v / (4 - 3 * v)
}

/**
 * Vanilla `getMaxLocalRawBrightness`: the brighter of block light and sky light, with the sky light reduced at night
 * (`skyDarken = 15 - SKY_LIGHT_LEVEL`). Undefined while the light of that spot is not known.
 */
export function rawLightAtEyes(block: number | undefined, sky: number | undefined, skyLevel: number): number | undefined {
  if (block === undefined && sky === undefined) return undefined
  const skyDarken = Math.max(0, 15 - skyLevel)
  return Math.max(block ?? 0, Math.max((sky ?? 0) - skyDarken, 0))
}

/** Target strength 0..1 for a light level; unknown light means no vignette (not a dark one). */
export function vignetteTarget(rawLight: number | undefined): number {
  return rawLight === undefined ? 0 : Math.min(1, Math.max(0, 1 - lightBrightness(rawLight)))
}

const TICK_MS = 50
/** Vanilla: `vignetteBrightness += (target - vignetteBrightness) * 0.01` per tick. */
export function easeVignette(current: number, target: number, dtMs: number): number {
  const keep = 0.99 ** (Math.max(0, dtMs) / TICK_MS)
  return target + (current - target) * keep
}

/** How dark the screen edges get at full strength (multiplied into the final pass). */
export const VIGNETTE_MAX_STRENGTH = 0.5
