/**
 * Maps app options storage → AppViewer runtime (in-world config, graphics config, menu background).
 * Call `subscribeRendererOptions` once after viewer init; keep volume sync in the app.
 */

import { subscribe } from 'valtio/vanilla'
import type { AppViewer } from './appViewer'
import type { RendererStorageOptions } from './rendererDefaultOptions'
import { rendererShaderCubeDebugModeToValue } from './rendererDefaultOptions'
import type { MenuBackgroundOptions } from '../three/menuBackground/types'
import type { MenuBackgroundRenderer } from '../three/menuBackground/renderer'
import { menuBackgroundSpeedToMultiplier } from '../three/menuBackground/config'
import type { V2CameraId, V2SceneId, MinecraftBlockGroupId } from '../three/menuBackground/v2'
import { setSkinsConfig } from '../lib/utils/skins'

export type { RendererStorageOptions } from './rendererDefaultOptions'

export interface ApplyRendererOptionsContext {
  isSafari?: boolean
  isCypress?: boolean
  windowFocused?: boolean
}

export interface RendererOptionsSubscribeHooks {
  isSafari?: boolean
  isCypress?: boolean
  getWindowFocused?: () => boolean
  onRegisterFocusHandlers?: (handlers: { onFocus: () => void, onBlur: () => void }) => void
}

export interface RendererWorldViewLike {
  keepChunksDistance: number
}

export function menuBackgroundOptionsFromStorage(o: Pick<
  RendererStorageOptions,
  | 'menuBackgroundMode'
  | 'menuBackgroundMinecraftTextures'
  | 'menuBackgroundV2Scene'
  | 'menuBackgroundV2Camera'
  | 'menuBackgroundV2BlockGroup'
  | 'menuBackgroundV2CameraSpeed'
  | 'menuBackgroundV2BlockSpeed'
>): MenuBackgroundOptions {
  return {
    mode: o.menuBackgroundMode as MenuBackgroundOptions['mode'],
    useMinecraftTextures: o.menuBackgroundMinecraftTextures,
    v2Scene: o.menuBackgroundV2Scene as V2SceneId,
    v2Camera: o.menuBackgroundV2Camera as V2CameraId,
    v2BlockGroup: o.menuBackgroundV2BlockGroup as MinecraftBlockGroupId,
    v2CameraSpeed: menuBackgroundSpeedToMultiplier(o.menuBackgroundV2CameraSpeed),
    v2BlockSpeed: menuBackgroundSpeedToMultiplier(o.menuBackgroundV2BlockSpeed),
  }
}

export function applyMenuBackgroundLiveOptions(
  menu: MenuBackgroundRenderer,
  o: Pick<
    RendererStorageOptions,
    | 'menuBackgroundV2Scene'
    | 'menuBackgroundV2Camera'
    | 'menuBackgroundV2BlockGroup'
    | 'menuBackgroundV2CameraSpeed'
    | 'menuBackgroundV2BlockSpeed'
  >
): void {
  const v2 = menu.v2
  if (!v2) return
  v2.setScene?.(o.menuBackgroundV2Scene)
  v2.setCamera?.(o.menuBackgroundV2Camera)
  void v2.setBlockGroup?.(o.menuBackgroundV2BlockGroup)
  v2.setCameraSpeed?.(menuBackgroundSpeedToMultiplier(o.menuBackgroundV2CameraSpeed))
  v2.setBlockSpeed?.(menuBackgroundSpeedToMultiplier(o.menuBackgroundV2BlockSpeed))
}

function resolveWasmMesherActive(o: RendererStorageOptions): boolean {
  return o.rendererMesher !== 'legacy-js'
}

function applyMesherWorkersPreset(
  appViewer: AppViewer,
  o: RendererStorageOptions,
  wasmActive: boolean
): void {
  const cfg = appViewer.inWorldRenderingConfig
  const override = o.rendererMeshersCountOverride
  const applyMesherWorkers = (workers: number) => {
    cfg.mesherWorkers = override ?? workers
  }
  switch (o.rendererWorldPerformance) {
    case 'low-energy':
      applyMesherWorkers(1)
      cfg.dedicatedChangeWorker = false
      break
    case 'normal':
      applyMesherWorkers(2)
      cfg.dedicatedChangeWorker = !wasmActive
      break
    case 'maximum':
      applyMesherWorkers(Math.max(3, Math.min(navigator.hardwareConcurrency ?? 0, 8)))
      cfg.dedicatedChangeWorker = !wasmActive
      break
  }
}

function applyFpsLimit(
  appViewer: AppViewer,
  o: RendererStorageOptions,
  windowFocused: boolean
): void {
  const backgroundFpsLimit = o.backgroundRendering
  const normalFpsLimit = o.frameLimit

  if (windowFocused) {
    appViewer.config.fpsLimit = normalFpsLimit || undefined
  } else if (backgroundFpsLimit === '5fps') {
    appViewer.config.fpsLimit = 5
  } else if (backgroundFpsLimit === '20fps') {
    appViewer.config.fpsLimit = 20
  } else {
    appViewer.config.fpsLimit = undefined
  }
}

function applyStatsVisible(
  appViewer: AppViewer,
  o: RendererStorageOptions,
  ctx: ApplyRendererOptionsContext
): void {
  const { renderDebug } = o
  if (renderDebug === 'none' || ctx.isCypress) {
    appViewer.config.statsVisible = 0
  } else if (renderDebug === 'basic') {
    appViewer.config.statsVisible = 1
  } else if (renderDebug === 'advanced') {
    appViewer.config.statsVisible = 2
  }
}

// ensure no object assigns to the config
export function applyRendererOptions(
  appViewer: AppViewer,
  o: RendererStorageOptions,
  ctx: ApplyRendererOptionsContext = {}
): void {
  const cfg = appViewer.inWorldRenderingConfig
  const wasmActive = resolveWasmMesherActive(o)

  cfg.showChunkBorders = o.showChunkBorders
  cfg.futuristicReveal = o.rendererFuturisticReveal
  applyMesherWorkersPreset(appViewer, o, wasmActive)
  cfg.renderEntities = o.renderEntities
  applyStatsVisible(appViewer, o, ctx)
  applyFpsLimit(appViewer, o, ctx.windowFocused !== false)

  cfg.vrSupport = o.vrSupport
  cfg.vrPageGameRendering = o.vrPageGameRendering
  cfg.enableDebugOverlay = o.rendererPerfDebugOverlay

  cfg.clipWorldBelowY = o.clipWorldBelowY
  cfg.extraBlockRenderers = !o.disableBlockEntityTextures
  cfg.fetchPlayerSkins = o.loadPlayerSkins
  cfg.highlightBlockColor = o.highlightBlockColor
  cfg.wasmMesher = wasmActive
  cfg.shaderCubeBlocks = o.rendererShaderCubeBlocks && wasmActive
  cfg.disableMesherConversionCache = !!ctx.isSafari

  setSkinsConfig({ apiEnabled: o.loadPlayerSkins })

  cfg.smoothLighting = o.smoothLighting
  cfg.shadingTheme = o.vanillaLook ? 'vanilla' : 'high-contrast'
  cfg.starfield = o.starfieldRendering
  cfg.defaultSkybox = o.defaultSkybox
  cfg.fov = o.fov
  cfg.shaderCubeDebugMode = rendererShaderCubeDebugModeToValue(o.rendererShaderCubeDebugMode)
}

/** World-view + hand/camera options (call when WorldView is ready). */
export function applyRendererWorldViewOptions(
  appViewer: AppViewer,
  worldView: RendererWorldViewLike,
  o: Pick<
    RendererStorageOptions,
    'keepChunksDistance' | 'renderEars' | 'showHand' | 'viewBobbing' | 'dayCycleAndLighting'
  >
): void {
  worldView.keepChunksDistance = o.keepChunksDistance
  const cfg = appViewer.inWorldRenderingConfig
  cfg.renderEars = o.renderEars
  cfg.showHand = o.showHand
  cfg.viewBobbing = o.viewBobbing
  cfg.dayCycle = o.dayCycleAndLighting
}

/**
 * Subscribe to options changes and sync renderer runtime.
 * Returns unsubscribe. Volume is intentionally excluded — wire it in the app.
 */
export function subscribeRendererOptions<T extends RendererStorageOptions>(
  appViewer: AppViewer,
  optionsProxy: T,
  hooks: RendererOptionsSubscribeHooks = {}
): () => void {
  appViewer.bindRendererOptions(() => optionsProxy as RendererStorageOptions)

  let windowFocused = hooks.getWindowFocused?.() ?? true

  const run = () => {
    const snapshot = optionsProxy as RendererStorageOptions
    applyRendererOptions(appViewer, snapshot, {
      isSafari: hooks.isSafari,
      isCypress: hooks.isCypress,
      windowFocused,
    })

    if (appViewer.currentDisplay === 'menu') {
      const menu = appViewer.backend?.getMenuBackground?.()
      if (menu) applyMenuBackgroundLiveOptions(menu, snapshot)
    }
  }

  run()

  hooks.onRegisterFocusHandlers?.({
    onFocus: () => {
      windowFocused = true
      run()
    },
    onBlur: () => {
      windowFocused = false
      run()
    },
  })

  return subscribe(optionsProxy, run)
}

/** Call when mineflayer bot is created (lighting depends on protocol features). */
export function applyRendererEnableLighting(
  appViewer: AppViewer,
  newVersionsLighting: boolean,
  blockStateIdSupported: boolean
): void {
  appViewer.inWorldRenderingConfig.enableLighting =
    !blockStateIdSupported || newVersionsLighting
}
