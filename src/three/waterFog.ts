/** Vanilla `Biome.waterFogColor` for most biomes (0x050533). */
export const DEFAULT_WATER_FOG_COLOR = 0x05_05_33

/** Vanilla `FogRenderer`: water fog ends 96 blocks away at full vision. */
export const WATER_FOG_FULL_DISTANCE = 96
/** Vision never drops below a quarter of the full distance, so 24 blocks right after diving in. */
export const WATER_FOG_MIN_VISION = 0.25
/** `LocalPlayer.waterVisionTime` caps at 600 ticks (30s at 20 TPS). */
export const WATER_VISION_TICKS = 600
export const TICKS_PER_SECOND = 20

/** Vanilla `LocalPlayer.getWaterVision`: sqrt ramp from 0 to 1 over 30s spent underwater. */
export function getWaterVision(secondsUnderwater: number): number {
  const ticks = Math.min(Math.max(secondsUnderwater, 0) * TICKS_PER_SECOND, WATER_VISION_TICKS)
  return Math.sqrt(ticks / WATER_VISION_TICKS)
}

/** Distance at which water fog is fully opaque. Conduit-like water breathing gives full vision at once. */
export function getWaterFogEnd(secondsUnderwater: number, waterBreathing: boolean): number {
  const vision = waterBreathing ? 1 : getWaterVision(secondsUnderwater)
  return WATER_FOG_FULL_DISTANCE * Math.max(WATER_FOG_MIN_VISION, vision)
}

/** 0xRRGGBB to 0..1 components (same raw-component convention the land fog already uses). */
export function waterFogColorToRgb(color: number): [number, number, number] {
  return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255]
}
