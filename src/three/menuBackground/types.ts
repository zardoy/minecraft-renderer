import type { ResourcesManager } from '../../resourcesManager/resourcesManager'
import type { V2CameraId, V2SceneId, MinecraftBlockGroupId } from './v2'
import { MENU_BACKGROUND_OPTION_DEFAULTS } from './config'

export type { V2CameraId, V2SceneId, MinecraftBlockGroupId } from './v2'

export type MenuBackgroundMode = 'classic' | 'v2' | 'worldBlocks'

export interface MenuBackgroundOptions {
  /** Visual style. Defaults to {@link MENU_BACKGROUND_OPTION_DEFAULTS.mode}, or `worldBlocks` in single-file build. */
  mode?: MenuBackgroundMode
  /** V2 style: load block atlas and render textured cubes (requires assets / mcData). */
  useMinecraftTextures?: boolean
  v2Scene?: V2SceneId
  v2Camera?: V2CameraId
  /** Block pool when {@link useMinecraftTextures} is enabled. */
  v2BlockGroup?: MinecraftBlockGroupId
  /** Camera path speed (1 = 100%). */
  v2CameraSpeed?: number
  /** Block fly-through + sky drift speed (1 = 100%). */
  v2BlockSpeed?: number
  /**
   * Optional shared resource manager (e.g. appViewer.resourcesManager).
   * Caller should run `updateAssetsData` after mcData is loaded when using textured cubes.
   */
  resourcesManager?: ResourcesManager
}

export function resolveMenuBackgroundMode(options?: MenuBackgroundOptions, singleFileBuild = false): MenuBackgroundMode {
  if (options?.mode) return options.mode
  if (singleFileBuild) return 'worldBlocks'
  return MENU_BACKGROUND_OPTION_DEFAULTS.mode
}
