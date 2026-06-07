import type { MenuBackgroundMode } from './types'
import type { V2CameraId, V2SceneId, MinecraftBlockGroupId } from './v2'

/** Single source of truth for menu-background defaults (settings + runtime fallbacks). */
export const MENU_BACKGROUND_OPTION_DEFAULTS = {
  mode: 'v2' as MenuBackgroundMode,
  minecraftTextures: true as boolean,
  v2Scene: 'light' as V2SceneId,
  v2Camera: 'dive' as V2CameraId,
  v2BlockGroup: 'stainedGlass' as MinecraftBlockGroupId,
  /** 0–200 (%). 100 = 1× motion. */
  v2CameraSpeedPercent: 80,
  v2BlockSpeedPercent: 40
} as const

export const menuBackgroundSpeedToMultiplier = (percent: number) => percent / 100

/** Default camera / block motion multipliers (1 = 100%). */
export const MENU_BACKGROUND_MOTION_DEFAULTS = {
  camera: menuBackgroundSpeedToMultiplier(MENU_BACKGROUND_OPTION_DEFAULTS.v2CameraSpeedPercent),
  block: menuBackgroundSpeedToMultiplier(MENU_BACKGROUND_OPTION_DEFAULTS.v2BlockSpeedPercent)
} as const
