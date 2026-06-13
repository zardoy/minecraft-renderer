import {
  V2_CAMERA_IDS,
  V2_CAMERA_LABELS,
  V2_SCENE_IDS,
  V2_SCENE_LABELS,
  MINECRAFT_BLOCK_GROUP_IDS,
  MINECRAFT_BLOCK_GROUP_LABELS
} from '../three/menuBackground/v2Meta'
import { MENU_BACKGROUND_OPTION_DEFAULTS } from '../three/menuBackground/config'
import type { RendererGpuPreference } from '../three/menuBackground/gpuPreference'

export type RendererOptionMeta = {
  possibleValues?: string[] | Array<[string, string]>
  isCustomInput?: boolean
  min?: number
  max?: number
  unit?: string
  text?: string
  tooltip?: string
  requiresRestart?: boolean
  requiresChunksReload?: boolean
}

export type RendererMesherPipeline = 'wasm' | 'legacy-js'

export type RendererShaderCubeDebugMode =
  | 'off'
  | 'holes'
  | 'texIndex'
  | 'faces'
  | 'atlasAlpha'

const SHADER_CUBE_DEBUG_MODE_TO_VALUE: Record<RendererShaderCubeDebugMode, number> = {
  off: 0,
  holes: 1,
  texIndex: 2,
  faces: 3,
  atlasAlpha: 4,
}

/** Maps stored option → `inWorldRenderingConfig.shaderCubeDebugMode` (0–4). */
export function rendererShaderCubeDebugModeToValue(mode: RendererShaderCubeDebugMode): number {
  return SHADER_CUBE_DEBUG_MODE_TO_VALUE[mode]
}

const MB = MENU_BACKGROUND_OPTION_DEFAULTS

/** Default values for options owned by minecraft-renderer (spread into app `defaultOptions`). */
export const RENDERER_DEFAULT_OPTIONS = {
  rendererWorldPerformance: 'normal' as 'low-energy' | 'normal' | 'maximum',
  rendererMeshersCountOverride: null as number | null,
  starfieldRendering: true as boolean,
  defaultSkybox: true as boolean,
  menuBackgroundMode: MB.mode,
  menuBackgroundMinecraftTextures: MB.minecraftTextures as boolean,
  menuBackgroundV2Scene: MB.v2Scene,
  menuBackgroundV2Camera: MB.v2Camera,
  menuBackgroundV2BlockGroup: MB.v2BlockGroup,
  menuBackgroundV2CameraSpeed: MB.v2CameraSpeedPercent,
  menuBackgroundV2BlockSpeed: MB.v2BlockSpeedPercent,
  rendererFuturisticReveal: false as boolean,
  rendererPerfDebugOverlay: false as boolean,
  disableBlockEntityTextures: false as boolean,
  rendererMesher: 'wasm' as RendererMesherPipeline,
  rendererShaderCubeBlocks: false as boolean,
  rendererShaderCubeDebugMode: 'off' as RendererShaderCubeDebugMode,
  showChunkBorders: false as boolean,
  renderEntities: true as boolean,
  renderDebug: 'basic' as 'none' | 'basic' | 'advanced',
  frameLimit: false as number | false,
  backgroundRendering: '20fps' as 'full' | '20fps' | '5fps',
  vanillaLook: false as boolean,
  smoothLighting: true as boolean,
  newVersionsLighting: false as boolean,
  vrSupport: true as boolean,
  vrPageGameRendering: false as boolean,
  clipWorldBelowY: undefined as number | undefined,
  highlightBlockColor: 'auto' as 'auto' | 'blue' | 'classic',
  loadPlayerSkins: true as boolean,
  renderEars: true as boolean,
  showHand: true as boolean,
  viewBobbing: true as boolean,
  dayCycleAndLighting: true as boolean,
  keepChunksDistance: 1,
  gpuPreference: 'default' as RendererGpuPreference,
  fov: 75
} as const

export type RendererDefaultOptionKey = keyof typeof RENDERER_DEFAULT_OPTIONS

/** App options storage shape for renderer-owned keys. */
export type RendererStorageOptions = typeof RENDERER_DEFAULT_OPTIONS

/**
 * Migrate persisted / legacy option keys into current {@link RENDERER_DEFAULT_OPTIONS} shape.
 * Call when loading saved settings (safe to run on every load).
 */
export function migrateRendererOptions(saved: Record<string, unknown>): void {
  if (saved.highPerformanceGpu) {
    saved.gpuPreference = 'high-performance'
    delete saved.highPerformanceGpu
  }
  if (saved.rendererMesher !== 'wasm' && saved.rendererMesher !== 'legacy-js') {
    if (typeof saved.rendererWasmMesher === 'boolean') {
      saved.rendererMesher = saved.rendererWasmMesher ? 'wasm' : 'legacy-js'
    } else if (typeof saved.wasmExperimentalMesher === 'boolean') {
      saved.rendererMesher = saved.wasmExperimentalMesher ? 'wasm' : 'legacy-js'
    }
  }
  delete saved.wasmExperimentalMesher
  delete saved.rendererWasmMesher

  if (saved.menuBackgroundMode === 'futuristic') {
    saved.menuBackgroundMode = 'v2'
  }
  const futuristicToV2: Array<[string, string]> = [
    ['menuBackgroundFuturisticScene', 'menuBackgroundV2Scene'],
    ['menuBackgroundFuturisticCamera', 'menuBackgroundV2Camera'],
    ['menuBackgroundFuturisticBlockGroup', 'menuBackgroundV2BlockGroup'],
    ['menuBackgroundFuturisticCameraSpeed', 'menuBackgroundV2CameraSpeed'],
    ['menuBackgroundFuturisticBlockSpeed', 'menuBackgroundV2BlockSpeed'],
  ]
  for (const [oldKey, newKey] of futuristicToV2) {
    if (saved[oldKey] !== undefined && saved[newKey] === undefined) {
      saved[newKey] = saved[oldKey]
    }
    delete saved[oldKey]
  }
}

/** Settings UI metadata for {@link RENDERER_DEFAULT_OPTIONS} keys. */
export const RENDERER_OPTIONS_META: Partial<Record<RendererDefaultOptionKey, RendererOptionMeta>> = {
  menuBackgroundMode: {
    possibleValues: [['classic', 'Classic'], ['v2', 'V2']],
    requiresRestart: true
  },
  menuBackgroundMinecraftTextures: {
    text: 'Minecraft block textures',
    tooltip: 'Use block atlas on V2 menu cubes (loads assets on menu)'
  },
  menuBackgroundV2Scene: {
    possibleValues: V2_SCENE_IDS.map(id => [id, V2_SCENE_LABELS[id]] as [string, string])
  },
  menuBackgroundV2Camera: {
    possibleValues: V2_CAMERA_IDS.map(id => [id, V2_CAMERA_LABELS[id]] as [string, string])
  },
  menuBackgroundV2BlockGroup: {
    possibleValues: MINECRAFT_BLOCK_GROUP_IDS.map(id => [id, MINECRAFT_BLOCK_GROUP_LABELS[id]] as [string, string]),
    text: 'Block pool',
    tooltip: 'Block set for textured menu cubes (requires Minecraft textures)'
  },
  menuBackgroundV2CameraSpeed: {
    text: 'Camera speed',
    tooltip: 'Orbit / fly-through camera path speed. 0 freezes the path; mouse parallax still works.',
    min: 0,
    max: 200,
    unit: '%'
  },
  menuBackgroundV2BlockSpeed: {
    text: 'Block speed',
    tooltip: 'Floating blocks and sky rotation. Independent of camera path speed.',
    min: 0,
    max: 200,
    unit: '%'
  },
  rendererWorldPerformance: {
    text: 'World performance',
    tooltip: 'Background workers for chunk geometry. Reload to apply.',
    requiresRestart: true,
    possibleValues: [
      ['low-energy', 'Low Energy'],
      ['normal', 'Normal'],
      ['maximum', 'Maximum']
    ]
  },
  starfieldRendering: {
    text: 'Starfield'
  },
  defaultSkybox: {
    text: 'Default skybox'
  },
  rendererFuturisticReveal: {
    text: 'Futuristic world reveal'
  },
  rendererPerfDebugOverlay: {
    text: 'Performance debug overlay'
  },
  disableBlockEntityTextures: {
    text: 'Disable block entity textures',
    tooltip: 'Skips signs, banners, heads, maps, etc.'
  },
  rendererMesher: {
    possibleValues: [['wasm', 'WASM'], ['legacy-js', 'Legacy JS']],
    text: 'Mesher pipeline',
    tooltip: 'WASM is faster. Use JS if WASM is not working. Requires reload.',
    requiresRestart: true
  },
  rendererShaderCubeBlocks: {
    text: '(UNSTABLE) Instanced shader cubes',
    tooltip: 'Render full blocks through the global GPU instanced path. Requires WASM mesher and WebGL2.',
    requiresChunksReload: true,
  },
  rendererShaderCubeDebugMode: {
    text: 'Shader cube debug',
    tooltip: 'Instanced cube path visualization (requires shader cubes enabled).',
    possibleValues: [
      ['off', 'Off'],
      ['holes', 'Hole test (red)'],
      ['texIndex', 'Tile index colors'],
      ['faces', 'Face id colors'],
      ['atlasAlpha', 'Atlas alpha'],
    ],
  },
  showChunkBorders: {
    text: 'Chunk borders'
  },
  renderEntities: {
    text: 'Render entities'
  },
  renderDebug: {
    possibleValues: ['advanced', 'basic', 'none']
  },
  frameLimit: {
    text: 'Frame limit',
    tooltip: 'false = VSync / unlimited when focused'
  },
  backgroundRendering: {
    text: 'Background FPS limit',
    possibleValues: [
      ['full', 'NO'],
      ['5fps', '5 FPS'],
      ['20fps', '20 FPS']
    ]
  },
  vanillaLook: {
    text: 'Vanilla shading',
    tooltip: 'On: Minecraft-style face shading. Off: higher-contrast client shading.'
  },
  smoothLighting: {},
  newVersionsLighting: {
    text: 'Lighting in newer versions'
  },
  vrSupport: {
    text: 'VR support',
    tooltip: 'Shows VR entry; does not force VR on.'
  },
  vrPageGameRendering: {
    text: 'VR page game rendering'
  },
  clipWorldBelowY: {
    text: 'Clip world below Y'
  },
  highlightBlockColor: {
    possibleValues: [
      ['auto', 'Auto'],
      ['blue', 'Blue'],
      ['classic', 'Classic']
    ]
  },
  loadPlayerSkins: {},
  renderEars: {
    tooltip: 'Deadmau5 ears when the skin texture includes them'
  },
  showHand: {},
  viewBobbing: {},
  dayCycleAndLighting: {
    text: 'Day cycle'
  },
  keepChunksDistance: {
    text: 'Keep chunks distance',
    tooltip: 'Extra distance before unloading chunks',
    max: 5,
    unit: ''
  },
  fov: {
    min: 30,
    max: 110,
    unit: '°',
    text: 'FOV'
  },
  gpuPreference: {
    text: 'GPU preference',
    tooltip: 'WebGL power preference. Requires reload / backend restart to apply.',
    requiresRestart: true,
    possibleValues: [
      ['default', 'Auto'],
      ['high-performance', 'Dedicated'],
      ['low-power', 'Low power']
    ]
  }
}

/** Grouped keys for the Render settings screen (section title + option keys). */
export const RENDERER_RENDER_GUI_SECTIONS: ReadonlyArray<{
  title: string
  keys: readonly RendererDefaultOptionKey[]
}> = [
    {
      title: 'World rendering',
      keys: [
        'rendererWorldPerformance',
        'starfieldRendering',
        'defaultSkybox',
        'disableBlockEntityTextures',
        'showChunkBorders',
        'renderEntities',
        'smoothLighting',
        'vanillaLook',
        'newVersionsLighting',
        'dayCycleAndLighting',
        'loadPlayerSkins',
        'renderEars',
        'showHand',
        'viewBobbing',
        'fov',
        'keepChunksDistance',
        'highlightBlockColor',
        'clipWorldBelowY'
      ]
    },
    {
      title: 'Frame pacing',
      keys: ['frameLimit', 'backgroundRendering', 'renderDebug', 'gpuPreference']
    },
    {
      title: 'VR',
      keys: ['vrSupport', 'vrPageGameRendering']
    },
    {
      title: 'Menu background',
      keys: [
        'menuBackgroundMode',
        'menuBackgroundMinecraftTextures',
        'menuBackgroundV2Scene',
        'menuBackgroundV2Camera',
        'menuBackgroundV2BlockGroup',
        'menuBackgroundV2CameraSpeed',
        'menuBackgroundV2BlockSpeed'
      ]
    },
    {
      title: 'Mesher',
      keys: ['rendererMesher', 'rendererShaderCubeBlocks']
    },
    {
      title: 'Renderer debug',
      keys: [
        'rendererFuturisticReveal',
        'rendererPerfDebugOverlay',
        'rendererShaderCubeDebugMode',
      ]
    }
  ]
