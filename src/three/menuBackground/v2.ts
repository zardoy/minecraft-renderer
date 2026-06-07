import * as THREE from 'three'
import type { DocumentRenderer } from '../documentRenderer'
import { ResourcesManager } from '../../resourcesManager/resourcesManager'
import { MENU_BACKGROUND_MC_VERSION } from './shared'
import type { MenuBackgroundView } from './activeView'
import { resizeMenuBackgroundCamera } from './activeView'
import { loadThreeJsTextureFromBitmap } from '../threeJsUtils'
import { MENU_BACKGROUND_MOTION_DEFAULTS, MENU_BACKGROUND_OPTION_DEFAULTS } from './config'
import {
  V2_CAMERA_IDS,
  V2_SCENE_IDS,
  MINECRAFT_BLOCK_GROUP_IDS,
  type V2CameraId,
  type V2SceneId,
  type MinecraftBlockGroupId,
} from './v2Meta'

export {
  V2_SCENE_IDS,
  V2_SCENE_LABELS,
  V2_CAMERA_IDS,
  V2_CAMERA_LABELS,
  MINECRAFT_BLOCK_GROUP_IDS,
  MINECRAFT_BLOCK_GROUP_LABELS,
} from './v2Meta'
export type { V2SceneId, V2CameraId, MinecraftBlockGroupId } from './v2Meta'

/** Mouse parallax scale (HTML prototype uses 1). */
const MOUSE_INFLUENCE = 0.1

export interface V2MenuBackgroundOptions {
  useMinecraftTextures?: boolean
  initialScene?: V2SceneId
  initialCamera?: V2CameraId
  initialBlockGroup?: MinecraftBlockGroupId
  /** Camera path speed multiplier (0 = frozen path; mouse parallax unchanged). */
  initialCameraSpeed?: number
  /** Floating blocks + sky drift speed multiplier. */
  initialBlockSpeed?: number
  resourcesManager?: ResourcesManager
}

/** Block pools for textured floating cubes (selected via {@link V2MenuBackground.setBlockGroup}). */
export const MINECRAFT_BLOCK_GROUPS = {
  mixed: [
    'white_wool', 'cyan_wool', 'blue_wool', 'purple_wool',
    'white_stained_glass', 'cyan_stained_glass', 'blue_stained_glass', 'purple_stained_glass',
    'glowstone', 'sea_lantern', 'amethyst_block', 'copper_block', 'gold_block', 'diamond_block'
  ],
  stainedGlass: [
    'white_stained_glass', 'orange_stained_glass', 'magenta_stained_glass', 'light_blue_stained_glass',
    'yellow_stained_glass', 'lime_stained_glass', 'pink_stained_glass', 'gray_stained_glass',
    'light_gray_stained_glass', 'cyan_stained_glass', 'purple_stained_glass', 'blue_stained_glass',
    'brown_stained_glass', 'green_stained_glass', 'red_stained_glass', 'black_stained_glass'
  ],
  wool: [
    'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool', 'lime_wool',
    'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool', 'purple_wool', 'blue_wool',
    'brown_wool', 'green_wool', 'red_wool', 'black_wool'
  ],
  construction: [
    'copper_block', 'exposed_copper', 'weathered_copper', 'oxidized_copper',
    'cut_copper', 'exposed_cut_copper', 'weathered_cut_copper', 'oxidized_cut_copper',
    'iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'netherite_block',
    'lapis_block', 'redstone_block', 'coal_block', 'quartz_block', 'amethyst_block',
    'bricks', 'stone_bricks', 'deepslate_bricks', 'polished_blackstone'
  ],
  glow: [
    'glowstone', 'sea_lantern', 'shroomlight', 'ochre_froglight', 'verdant_froglight', 'pearlescent_froglight',
    'redstone_lamp', 'beacon'
  ],
  world: [
    'grass_block', 'podzol', 'mycelium', 'dirt', 'coarse_dirt', 'rooted_dirt', 'mud', 'clay',
    'stone', 'cobblestone', 'mossy_cobblestone', 'deepslate', 'cobbled_deepslate', 'tuff', 'calcite',
    'sand', 'red_sand', 'gravel', 'snow_block',
    'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore',
    'gold_ore', 'deepslate_gold_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
    'lapis_ore', 'deepslate_lapis_ore', 'redstone_ore', 'deepslate_redstone_ore', 'nether_gold_ore', 'ancient_debris',
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
    'netherrack', 'soul_sand', 'basalt', 'end_stone'
  ]
} as const

interface ScenePalette {
  bg: number
  fog: number
  fogD: number
  blocks: number[]
  emit: number[]
  nebula: number[]
  galFn: (b: number) => THREE.Color
  ambient: number
  dir: number
  pt1: number
  pt2: number
  name: string
  /** Vertical (or radial) sky gradient instead of a flat scene background. */
  gradientBg?: { top: number, mid?: number, bottom: number, radial?: boolean }
  starColor?: number
  starOpacity?: number
  galaxyOpacity?: number
  nebulaOpacity?: number
  edgeLineColor?: number
  blockOpacity?: [number, number]
}

interface CameraMode {
  pos: (t: number, mx: number, my: number) => { x: number, y: number, z: number }
  look: (t: number, mx: number, my: number) => { x: number, y: number, z: number }
  roll: (t: number, mx?: number) => number
  spd: number
}

interface FloatingBlock {
  mesh: THREE.Mesh
  spd: number
  dx: number
  dy: number
  rx: number
  ry: number
  rz: number
  minecraftBlockName?: string
}

const PAL: Record<V2SceneId, ScenePalette> = {
  galaxy: {
    bg: 0x02_04_12, fog: 0x02_04_12, fogD: 0.011,
    blocks: [0x00_f0_ff, 0x00_d4_ff, 0x00_b8_ff, 0x00_e8_ff, 0x22_cc_ff, 0x00_a8_ff],
    emit: [0x00_33_66, 0x00_22_55, 0x00_1a_44],
    nebula: [0x00_11_33, 0x11_00_22, 0x00_11_22],
    galFn: b => new THREE.Color(b * 0.05, b * 0.2, b),
    ambient: 0x04_08_18, dir: 0x33_66_ff, pt1: 0x00_aa_ff, pt2: 0xff_44_ff, name: 'GALAXY'
  },
  nether: {
    bg: 0x0e_01_00, fog: 0x0e_01_00, fogD: 0.016,
    blocks: [0xff_22_00, 0xff_66_00, 0xff_99_00, 0xcc_11_00, 0xff_44_22, 0xff_aa_00],
    emit: [0x22_08_00, 0x11_00_00, 0x33_11_00],
    nebula: [0x1a_04_00, 0x0d_00_00, 0x1a_08_00],
    galFn: b => new THREE.Color(b, b * 0.15, 0),
    ambient: 0x18_02_00, dir: 0xff_33_00, pt1: 0xff_44_00, pt2: 0xff_aa_00, name: 'NETHER'
  },
  end: {
    bg: 0x00_00_00, fog: 0x00_00_00, fogD: 0.009,
    blocks: [0x77_22_aa, 0xaa_44_cc, 0x55_00_77, 0xdd_aa_ff, 0x33_00_55, 0xbb_aa_ff],
    emit: [0x0a_00_15, 0x18_00_25, 0x05_00_10],
    nebula: [0x08_00_18, 0x0d_00_15, 0x04_00_0e],
    galFn: b => new THREE.Color(b * 0.4, 0, b),
    ambient: 0x06_00_10, dir: 0x99_33_ff, pt1: 0xaa_44_ff, pt2: 0x44_00_aa, name: 'THE END'
  },
  cyber: {
    bg: 0x00_0a_06, fog: 0x00_0a_06, fogD: 0.010,
    blocks: [0x00_ff_ff, 0x00_ff_88, 0xaa_ff_00, 0x00_cc_ff, 0x66_ff_00, 0x00_ff_ee],
    emit: [0x00_22_11, 0x00_1a_00, 0x00_1a_22],
    nebula: [0x00_1a_12, 0x00_14_00, 0x00_12_1a],
    galFn: b => new THREE.Color(0, b, b * 0.6),
    ambient: 0x00_1a_0d, dir: 0x00_ff_aa, pt1: 0x00_ff_cc, pt2: 0x44_ff_00, name: 'CYBER'
  },
  light: {
    bg: 0x88_98_b0,
    fog: 0x78_88_a0,
    fogD: 0.006,
    gradientBg: { top: 0xd8_e4_f8, mid: 0xa0_b0_c8, bottom: 0x68_78_90, radial: true },
    blocks: [
      0xe8_f2_ff, 0xd0_e8_ff, 0xb8_d8_ff, 0xa0_c8_f8, 0x88_b8_f0, 0x70_a8_e8,
      0x98_c8_ff, 0xc0_e0_ff, 0xf0_f8_ff, 0x78_b0_e8, 0xd8_ec_ff, 0xe0_e8_ff
    ],
    emit: [0x68_98_d0, 0x88_b0_e0, 0xa8_c8_f0, 0xc0_d8_f8],
    nebula: [0x90_a8_c8, 0xa8_c0_e0, 0xc0_d4_ec, 0xd8_e8_f8, 0x78_90_b0],
    galFn: b => {
      const c = new THREE.Color()
      if (b < 0.4) {
        c.lerpColors(new THREE.Color(0xf4_f8_ff), new THREE.Color(0xd8_e8_ff), b / 0.4)
      } else if (b < 0.75) {
        c.lerpColors(new THREE.Color(0xd8_e8_ff), new THREE.Color(0xa8_c8_f0), (b - 0.4) / 0.35)
      } else {
        c.lerpColors(new THREE.Color(0xa8_c8_f0), new THREE.Color(0x90_b0_e0), (b - 0.75) / 0.25)
      }
      return c
    },
    ambient: 0x78_88_a0,
    dir: 0xd0_dce8,
    pt1: 0xa8_c8_ff,
    pt2: 0xc8_d8_ff,
    name: 'LIGHT',
    starColor: 0xe8_f0_ff,
    starOpacity: 0.5,
    galaxyOpacity: 0.7,
    nebulaOpacity: 0.32,
    edgeLineColor: 0x98_c0_e8,
    blockOpacity: [0.42, 0.56]
  }
}

const CAMS: Record<V2CameraId, CameraMode> = {
  cruise: {
    pos: (t, mx, my) => ({ x: Math.sin(t * 0.28) * 18 + Math.cos(t * 0.11) * 7 + mx * 10, y: Math.sin(t * 0.19) * 6 + Math.cos(t * 0.31) * 3 + my * 6, z: 0 }),
    look: (t, mx, my) => ({ x: Math.sin((t + 0.18) * 0.28) * 18 + mx * 8, y: Math.sin((t + 0.18) * 0.19) * 6 + my * 4, z: -25 }),
    roll: (t, mx = 0) => mx * 0.05 + Math.sin(t * 0.22) * 0.015,
    spd: 0.18
  },
  barrel: {
    pos: (t, mx, my) => {
      const r = 10
      const s = t * 2.4
      return { x: Math.cos(s) * r + mx * 4, y: Math.sin(s) * r + my * 4, z: Math.sin(t * 0.4) * 8 }
    },
    look: t => ({ x: Math.sin(t * 0.5) * 5, y: Math.cos(t * 0.5) * 5, z: -30 }),
    roll: t => t * 2.4 + Math.PI * 0.5,
    spd: 0.24
  },
  dive: {
    pos: (t, mx, my) => ({ x: Math.sin(t * 0.6) * 30 + mx * 8, y: Math.cos(t * 0.4) * 18 + my * 6, z: Math.sin(t * 0.3) * 12 }),
    look: (t, mx, my) => ({ x: Math.sin(t * 0.6 + 0.2) * 30 + mx * 6, y: Math.cos(t * 0.4 + 0.2) * 18 - 8 + my * 4, z: -35 }),
    roll: (t, mx = 0) => mx * 0.08 + Math.sin(t * 0.6) * 0.12,
    spd: 0.3
  },
  orbit: {
    pos: (t, mx, my) => ({ x: Math.cos(t * 0.5) * 20 + mx * 5, y: Math.sin(t * 0.25) * 10 + my * 5, z: Math.sin(t * 0.5) * 20 }),
    look: () => ({ x: 0, y: 0, z: -60 }),
    roll: t => Math.sin(t * 0.5) * 0.08,
    spd: 0.15
  },
  snake: {
    pos: (t, mx, my) => ({ x: Math.sin(t * 1.1) * 22 + Math.sin(t * 0.37) * 8 + mx * 10, y: Math.sin(t * 0.7) * 10 + mx * 4 + my * 8, z: 0 }),
    look: (t, mx, my) => {
      const la = t + 0.12
      return { x: Math.sin(la * 1.1) * 22 + Math.sin(la * 0.37) * 8 + mx * 8, y: Math.sin(la * 0.7) * 10 + my * 6, z: -22 }
    },
    roll: (t, mx = 0) => mx * 0.1 + Math.sin(t * 1.1) * 0.06,
    spd: 0.22
  }
}

const CAM_SPD: Record<V2CameraId, number> = {
  cruise: 1,
  barrel: 1.6,
  dive: 2.2,
  orbit: 0.7,
  snake: 1.4
}

const BCOUNT = 250
const GCNT = 10_000
const NCNT = 3000

const rp = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]

const colorHex = (n: number) => '#' + n.toString(16).padStart(6, '0')

const makeSkyGradientTexture = (gradient: NonNullable<ScenePalette['gradientBg']>): THREE.CanvasTexture | null => {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 512
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const w = canvas.width
  const h = canvas.height
  const grad = gradient.radial
    ? ctx.createRadialGradient(w / 2, h * 0.32, 0, w / 2, h * 0.32, h * 0.85)
    : ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, colorHex(gradient.top))
  if (gradient.mid != null) grad.addColorStop(0.45, colorHex(gradient.mid))
  grad.addColorStop(1, colorHex(gradient.bottom))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

export class V2MenuBackground implements MenuBackgroundView {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera

  private readonly ambient: THREE.AmbientLight
  private readonly dir: THREE.DirectionalLight
  private readonly pt1: THREE.PointLight
  private readonly pt2: THREE.PointLight
  private readonly blocks: FloatingBlock[] = []
  private readonly bGroup = new THREE.Group()
  private readonly galaxy: THREE.Points
  private readonly nebula: THREE.Points
  private readonly stars: THREE.Points
  private readonly galGeo: THREE.BufferGeometry
  private readonly nebGeo: THREE.BufferGeometry
  private readonly bGeo = new THREE.BoxGeometry(1, 1, 1)
  private readonly eGeo = new THREE.EdgesGeometry(this.bGeo)

  private curScene: V2SceneId
  private curCam: V2CameraId
  private blockGroup: MinecraftBlockGroupId
  private cameraSpeed: number
  private blockSpeed: number
  private camT = 0
  private mx = 0
  private my = 0
  private tmx = 0
  private tmy = 0
  private transitioning = false
  private useMinecraftTextures = false
  private readonly resourcesManager?: ResourcesManager
  private atlasTexture: THREE.Texture | null = null
  private blockMaterialPool = new Map<string, THREE.MeshBasicMaterial>()
  private gradientSky: THREE.Mesh | null = null
  private gradientSkyTexture: THREE.CanvasTexture | null = null
  private disposed = false
  private animTime = 0
  private texturesApplied = false
  private textureLoadInProgress = false
  private onAssetsTexturesUpdated?: () => void

  constructor(
    private readonly documentRenderer: DocumentRenderer,
    options: V2MenuBackgroundOptions = {},
    private readonly abortSignal?: AbortSignal
  ) {
    const d = MENU_BACKGROUND_OPTION_DEFAULTS
    this.curScene = options.initialScene ?? d.v2Scene
    this.curCam = options.initialCamera ?? d.v2Camera
    this.blockGroup = options.initialBlockGroup ?? d.v2BlockGroup
    this.cameraSpeed = options.initialCameraSpeed ?? MENU_BACKGROUND_MOTION_DEFAULTS.camera
    this.blockSpeed = options.initialBlockSpeed ?? MENU_BACKGROUND_MOTION_DEFAULTS.block
    this.useMinecraftTextures = options.useMinecraftTextures ?? d.minecraftTextures
    this.resourcesManager = options.resourcesManager

    const pal = PAL[this.curScene]
    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.FogExp2(pal.fog, pal.fogD)
    this.applyScenePalette(pal)

    this.camera = new THREE.PerspectiveCamera(
      80,
      this.documentRenderer.canvas.width / this.documentRenderer.canvas.height,
      0.1,
      700
    )

    this.ambient = new THREE.AmbientLight(pal.ambient, 2.5)
    this.scene.add(this.ambient)
    this.dir = new THREE.DirectionalLight(pal.dir, 4)
    this.dir.position.set(1, 1, 0)
    this.scene.add(this.dir)
    this.pt1 = new THREE.PointLight(pal.pt1, 5, 100)
    this.scene.add(this.pt1)
    this.pt2 = new THREE.PointLight(pal.pt2, 4, 80)
    this.pt2.position.set(30, 20, -30)
    this.scene.add(this.pt2)

    for (let i = 0; i < BCOUNT; i++) this.spawnBlock(pal, true)
    if (!this.useMinecraftTextures) {
      const edgeColor = pal.edgeLineColor ?? 0x00_f5_ff
      for (let i = 0; i < 40; i++) {
        const lm = new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.25 })
        rp(this.blocks).mesh.add(new THREE.LineSegments(this.eGeo, lm))
      }
    }
    this.scene.add(this.bGroup)

    const sGeo = new THREE.BufferGeometry()
    const sp = new Float32Array(5000 * 3)
    for (let i = 0; i < 5000 * 3; i++) sp[i] = (Math.random() - 0.5) * 500
    sGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3))
    this.stars = new THREE.Points(sGeo, new THREE.PointsMaterial({
      color: pal.starColor ?? 0xff_ff_ff,
      size: 0.3,
      transparent: true,
      opacity: pal.starOpacity ?? 0.7,
      sizeAttenuation: true
    }))
    this.scene.add(this.stars)

    this.galGeo = new THREE.BufferGeometry()
    const gp = new Float32Array(GCNT * 3)
    const gc = new Float32Array(GCNT * 3)
    for (let i = 0; i < GCNT; i++) {
      const arm = i % 3
      const t = Math.random()
      const ang = (arm / 3) * Math.PI * 2 + t * Math.PI * 5
      const r = t * 90 + Math.random() * 10
      const sc = (1 - t) * 18
      gp[i * 3] = Math.cos(ang) * r + (Math.random() - 0.5) * sc
      gp[i * 3 + 1] = (Math.random() - 0.5) * 7
      gp[i * 3 + 2] = Math.sin(ang) * r + (Math.random() - 0.5) * sc - 180
      const b = 0.2 + t * 0.8
      const c = pal.galFn(b)
      gc[i * 3] = c.r
      gc[i * 3 + 1] = c.g
      gc[i * 3 + 2] = c.b
    }
    this.galGeo.setAttribute('position', new THREE.BufferAttribute(gp, 3))
    this.galGeo.setAttribute('color', new THREE.BufferAttribute(gc, 3))
    this.galaxy = new THREE.Points(this.galGeo, new THREE.PointsMaterial({
      size: 0.9, vertexColors: true, transparent: true, opacity: pal.galaxyOpacity ?? 0.55, sizeAttenuation: true
    }))
    this.scene.add(this.galaxy)

    this.nebGeo = new THREE.BufferGeometry()
    const np = new Float32Array(NCNT * 3)
    const nc = new Float32Array(NCNT * 3)
    for (let i = 0; i < NCNT; i++) {
      const r = 25 + Math.random() * 110
      const th = Math.random() * Math.PI * 2
      const ph = (Math.random() - 0.5) * Math.PI * 0.5
      np[i * 3] = r * Math.cos(th) * Math.cos(ph)
      np[i * 3 + 1] = r * Math.sin(ph) * 0.6
      np[i * 3 + 2] = r * Math.sin(th) * Math.cos(ph) - 80
      const c = new THREE.Color(rp(pal.nebula))
      nc[i * 3] = c.r
      nc[i * 3 + 1] = c.g
      nc[i * 3 + 2] = c.b
    }
    this.nebGeo.setAttribute('position', new THREE.BufferAttribute(np, 3))
    this.nebGeo.setAttribute('color', new THREE.BufferAttribute(nc, 3))
    this.nebula = new THREE.Points(this.nebGeo, new THREE.PointsMaterial({
      size: 3, vertexColors: true, transparent: true, opacity: pal.nebulaOpacity ?? 0.3, sizeAttenuation: true
    }))
    this.scene.add(this.nebula)

    this.addBackgroundTextPlane()
    this.setupMouseTracking()
  }

  async init() {
    if (!this.useMinecraftTextures) return
    void this.scheduleMinecraftTextureLoad()
  }

  private scheduleMinecraftTextureLoad() {
    if (!this.useMinecraftTextures || this.disposed || this.texturesApplied || this.textureLoadInProgress) return
    void this.tryApplyMinecraftTextures()
  }

  private attachAssetsListener() {
    const rm = this.resourcesManager
    if (!rm || this.onAssetsTexturesUpdated) return
    this.onAssetsTexturesUpdated = () => this.scheduleMinecraftTextureLoad()
    rm.on('assetsTexturesUpdated', this.onAssetsTexturesUpdated)
  }

  private detachAssetsListener() {
    const rm = this.resourcesManager
    if (!rm || !this.onAssetsTexturesUpdated) return
    rm.off('assetsTexturesUpdated', this.onAssetsTexturesUpdated)
    this.onAssetsTexturesUpdated = undefined
  }

  private hasBlockAtlas(resourcesManager: ResourcesManager): boolean {
    const resources = resourcesManager.currentResources
    return !!(resources?.blocksAtlasImage && resources.blocksAtlasJson)
  }

  private async ensureAtlasReady(resourcesManager: ResourcesManager): Promise<boolean> {
    await this.ensureMcDataLoaded()
    if (this.hasBlockAtlas(resourcesManager)) return true

    if (typeof document === 'undefined' && resourcesManager !== this.resourcesManager) {
      return false
    }

    resourcesManager.currentConfig = {
      ...resourcesManager.currentConfig,
      version: MENU_BACKGROUND_MC_VERSION,
      noInventoryGui: true
    }

    try {
      await resourcesManager.updateAssetsData?.({})
    } catch {
      return false
    }

    return this.hasBlockAtlas(resourcesManager)
  }

  private async tryApplyMinecraftTextures() {
    if (this.disposed || !this.useMinecraftTextures || this.texturesApplied) return

    this.textureLoadInProgress = true
    try {
      const resourcesManager = this.resourcesManager ?? new ResourcesManager()
      const ready = await this.ensureAtlasReady(resourcesManager)
      if (!ready) {
        if (this.resourcesManager) this.attachAssetsListener()
        return
      }
      if (this.disposed) return

      this.applyMinecraftTexturesFromAtlas(resourcesManager)
      this.texturesApplied = true
      this.detachAssetsListener()
    } catch (err) {
      console.warn('[V2MenuBackground] Failed to load Minecraft textures, using solid colors:', err)
      this.useMinecraftTextures = false
      this.detachAssetsListener()
    } finally {
      this.textureLoadInProgress = false
    }
  }

  private applyScenePalette(pal: ScenePalette) {
    this.documentRenderer.renderer.setClearColor(pal.bg)
    if (pal.gradientBg) {
      this.scene.background = null
      if (!this.gradientSky) {
        const tex = makeSkyGradientTexture(pal.gradientBg)
        if (tex) {
          this.gradientSkyTexture = tex
          this.gradientSky = new THREE.Mesh(
            new THREE.PlaneGeometry(900, 700),
            new THREE.MeshBasicMaterial({
              map: tex,
              depthWrite: false,
              side: THREE.DoubleSide
            })
          )
          this.gradientSky.position.set(0, 0, -280)
          this.gradientSky.renderOrder = -1000
          this.scene.add(this.gradientSky)
        } else {
          this.scene.background = new THREE.Color(pal.bg)
        }
      } else {
        this.gradientSky.visible = true
        if (this.gradientSkyTexture && pal.gradientBg) {
          const next = makeSkyGradientTexture(pal.gradientBg)
          if (next) {
            this.gradientSkyTexture.dispose()
            this.gradientSkyTexture = next
              ; (this.gradientSky.material as THREE.MeshBasicMaterial).map = next
              ; (this.gradientSky.material as THREE.MeshBasicMaterial).needsUpdate = true
          }
        }
      }
    } else {
      this.scene.background = new THREE.Color(pal.bg)
      if (this.gradientSky) this.gradientSky.visible = false
    }
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.set(pal.fog)
      this.scene.fog.density = pal.fogD
    }
    const starMat = this.stars?.material as THREE.PointsMaterial | undefined
    if (starMat) {
      starMat.color.set(pal.starColor ?? 0xff_ff_ff)
      starMat.opacity = pal.starOpacity ?? 0.7
    }
    const galMat = this.galaxy?.material as THREE.PointsMaterial | undefined
    if (galMat) galMat.opacity = pal.galaxyOpacity ?? 0.55
    const nebMat = this.nebula?.material as THREE.PointsMaterial | undefined
    if (nebMat) nebMat.opacity = pal.nebulaOpacity ?? 0.3
  }

  private setupMouseTracking() {
    const onMove = (e: MouseEvent) => {
      const w = typeof window !== 'undefined' ? window.innerWidth : this.documentRenderer.canvas.width
      const h = typeof window !== 'undefined' ? window.innerHeight : this.documentRenderer.canvas.height
      this.tmx = (e.clientX / w - 0.5) * 2
      this.tmy = -(e.clientY / h - 0.5) * 2
    }
    const target = typeof document !== 'undefined' ? document : undefined
    target?.addEventListener('mousemove', onMove, { signal: this.abortSignal })
  }

  private addBackgroundTextPlane() {
    const tw = 2048
    const th = 768
    const tc = typeof document !== 'undefined' ? document.createElement('canvas') : null
    if (!tc) return
    tc.width = tw
    tc.height = th
    const ctx = tc.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, tw, th)
    ctx.save()
    ctx.font = 'bold 560px Orbitron, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(0,200,255,0.35)'
    ctx.shadowBlur = 80
    ctx.fillStyle = 'rgba(255,255,255,0.055)'
    ctx.fillText('V2', tw * 0.28, th * 0.5)
    ctx.restore()
    ctx.save()
    ctx.font = 'bold 148px Orbitron, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(0,200,255,0.2)'
    ctx.shadowBlur = 40
    ctx.fillStyle = 'rgba(255,255,255,0.038)'
    ctx.fillText('by ZARDOY', tw * 0.72, th * 0.52)
    ctx.restore()

    const tex = new THREE.CanvasTexture(tc)
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(280, 105),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
      })
    )
    plane.position.set(8, 4, -320)
    this.scene.add(plane)
  }

  private spawnBlock(pal: ScenePalette, init: boolean, blockName?: string) {
    const mat = this.createBlockMaterial(pal, blockName)
    const mesh = new THREE.Mesh(this.bGeo, mat)
    const s = 0.3 + Math.random() * 3
    mesh.scale.setScalar(s)
    mesh.position.set(
      (Math.random() - 0.5) * 140,
      (Math.random() - 0.5) * 70,
      init ? -(Math.random() * 140) : -155 - Math.random() * 30
    )
    mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2)
    const d: FloatingBlock = {
      mesh,
      spd: 0.04 + Math.random() * 0.12,
      dx: (Math.random() - 0.5) * 0.012,
      dy: (Math.random() - 0.5) * 0.008,
      rx: (Math.random() - 0.5) * 0.012,
      ry: (Math.random() - 0.5) * 0.012,
      rz: (Math.random() - 0.5) * 0.01,
      minecraftBlockName: blockName
    }
    this.blocks.push(d)
    this.bGroup.add(mesh)
  }

  private createBlockMaterial(pal: ScenePalette, blockName?: string): THREE.MeshBasicMaterial {
    if (this.useMinecraftTextures && blockName) {
      const cached = this.blockMaterialPool.get(blockName)
      if (cached) return cached.clone()
    }
    // Unlit neon cubes — no specular / scene-light response
    const [opMin, opMax] = pal.blockOpacity ?? [0.32, 0.46]
    return new THREE.MeshBasicMaterial({
      color: rp(pal.blocks),
      transparent: true,
      opacity: opMin + Math.random() * (opMax - opMin),
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  }

  private removeBlockEdgeLines() {
    for (const block of this.blocks) {
      const edges = block.mesh.children.filter(c => c instanceof THREE.LineSegments)
      for (const edge of edges) {
        block.mesh.remove(edge)
        edge.geometry?.dispose()
        const mat = (edge as THREE.LineSegments).material
        if (Array.isArray(mat)) mat.forEach(m => m.dispose())
        else mat.dispose()
      }
    }
  }

  private async ensureMcDataLoaded() {
    const loadMcData = (globalThis as { _LOAD_MC_DATA?: () => Promise<void> })._LOAD_MC_DATA
    if (loadMcData) {
      await loadMcData()
    }
  }

  private resolveBlockAtlasUv(
    blockName: string,
    textures: Record<string, { u: number, v: number, su?: number, sv?: number }>,
    atlasJson: { suSv: number }
  ): { u: number, v: number, su: number, sv: number } | null {
    const pick = (key: string) => {
      const tex = textures[key]
      if (!tex) return null
      return {
        u: tex.u,
        v: tex.v,
        su: tex.su ?? atlasJson.suSv,
        sv: tex.sv ?? atlasJson.suSv
      }
    }
    if (textures[blockName]) return pick(blockName)
    for (const suffix of ['_top', '_side', '_front', '_0']) {
      const uv = pick(`${blockName}${suffix}`)
      if (uv) return uv
    }
    for (const key of Object.keys(textures)) {
      if (key.startsWith(blockName)) return pick(key)
    }
    return null
  }

  private applyMinecraftTexturesFromAtlas(resourcesManager: ResourcesManager) {
    const resources = resourcesManager.currentResources
    if (!resources?.blocksAtlasImage || !resources.blocksAtlasJson) {
      throw new Error('Block atlas not available')
    }

    const atlasJson = resources.blocksAtlasJson
    const textures = atlasJson.textures

    // Same path as WorldRendererThree — ImageBitmap → canvas Texture
    this.atlasTexture = loadThreeJsTextureFromBitmap(resources.blocksAtlasImage)
    this.atlasTexture.flipY = false
    this.atlasTexture.needsUpdate = true

    for (const blockName of MINECRAFT_BLOCK_GROUPS[this.blockGroup]) {
      const uv = this.resolveBlockAtlasUv(blockName, textures, atlasJson)
      if (!uv) continue
      const map = this.atlasTexture.clone()
      map.flipY = false
      map.offset.set(uv.u, uv.v)
      map.repeat.set(uv.su, uv.sv)
      map.needsUpdate = true
      const isGlass = blockName.includes('glass')
      const mat = new THREE.MeshBasicMaterial({
        map,
        side: THREE.DoubleSide,
        transparent: isGlass,
        opacity: isGlass ? 0.85 : 1,
        alphaTest: isGlass ? 0.08 : 0,
        depthWrite: true,
        toneMapped: false
      })
      this.blockMaterialPool.set(blockName, mat)
    }

    if (this.blockMaterialPool.size === 0) {
      throw new Error('No block textures resolved from atlas (check block names vs atlas keys)')
    }

    this.removeBlockEdgeLines()

    for (const block of this.blocks) {
      const name = rp([...this.blockMaterialPool.keys()])
      block.minecraftBlockName = name
      block.mesh.material = this.blockMaterialPool.get(name)!.clone()
    }
  }

  setScene(name: V2SceneId) {
    if (!(V2_SCENE_IDS as readonly string[]).includes(name)) return
    if (name === this.curScene || this.transitioning) return
    this.transitioning = true
    this.curScene = name
    const pal = PAL[name]
    setTimeout(() => {
      if (this.disposed) return
      this.applyScenePalette(pal)
      this.ambient.color.set(pal.ambient)
      this.dir.color.set(pal.dir)
      this.pt1.color.set(pal.pt1)
      this.pt2.color.set(pal.pt2)
      for (const b of this.blocks) {
        if (this.useMinecraftTextures && b.minecraftBlockName) continue
        if (b.mesh.material instanceof THREE.MeshBasicMaterial) {
          b.mesh.material.color.set(rp(pal.blocks))
        }
      }
      const ncA = this.nebGeo.attributes.color as THREE.BufferAttribute
      for (let i = 0; i < NCNT; i++) {
        const c = new THREE.Color(rp(pal.nebula))
        ncA.setXYZ(i, c.r, c.g, c.b)
      }
      ncA.needsUpdate = true
      const gcA = this.galGeo.attributes.color as THREE.BufferAttribute
      for (let i = 0; i < GCNT; i++) {
        const b = 0.2 + Math.random() * 0.8
        const c = pal.galFn(b)
        gcA.setXYZ(i, c.r, c.g, c.b)
      }
      gcA.needsUpdate = true
      this.transitioning = false
    }, 150)
  }

  setCamera(name: V2CameraId) {
    if (!(V2_CAMERA_IDS as readonly string[]).includes(name)) return
    this.curCam = name
  }

  setCameraSpeed(speed: number) {
    this.cameraSpeed = Math.max(0, speed)
  }

  setBlockSpeed(speed: number) {
    this.blockSpeed = Math.max(0, speed)
  }

  async setBlockGroup(name: MinecraftBlockGroupId) {
    if (!(MINECRAFT_BLOCK_GROUP_IDS as readonly string[]).includes(name)) return
    if (name === this.blockGroup) return
    this.blockGroup = name
    if (!this.useMinecraftTextures || this.disposed) return
    for (const mat of this.blockMaterialPool.values()) {
      mat.map?.dispose()
      mat.dispose()
    }
    this.blockMaterialPool.clear()
    this.texturesApplied = false
    this.scheduleMinecraftTextureLoad()
  }

  getSceneId(): V2SceneId {
    return this.curScene
  }

  getCameraId(): V2CameraId {
    return this.curCam
  }

  getBlockGroupId(): MinecraftBlockGroupId {
    return this.blockGroup
  }

  update(dt: number, sizeChanged: boolean) {
    if (sizeChanged) {
      resizeMenuBackgroundCamera(this.camera, this.documentRenderer.canvas)
    }

    const mode = CAMS[this.curCam]
    const cameraMotion = this.cameraSpeed
    const blockMotion = this.blockSpeed
    this.camT += dt * mode.spd * cameraMotion
    this.mx += (this.tmx - this.mx) * 0.05
    this.my += (this.tmy - this.my) * 0.05

    const smx = this.mx * MOUSE_INFLUENCE
    const smy = this.my * MOUSE_INFLUENCE

    const p = mode.pos(this.camT, smx, smy)
    const l = mode.look(this.camT, smx, smy)
    this.camera.position.set(p.x, p.y, p.z)
    this.camera.lookAt(l.x, l.y, l.z)
    this.camera.rotation.z = mode.roll(this.camT, smx)

    const mul = CAM_SPD[this.curCam] * blockMotion
    this.animTime += dt * 1000 * blockMotion
    for (const b of this.blocks) {
      b.mesh.position.z += b.spd * mul * 60 * dt
      b.mesh.position.x += b.dx * 60 * dt * blockMotion
      b.mesh.position.y += b.dy * 60 * dt * blockMotion
      b.mesh.rotation.x += b.rx * mul
      b.mesh.rotation.y += b.ry * mul
      b.mesh.rotation.z += b.rz
      if (!this.useMinecraftTextures && b.mesh.material instanceof THREE.MeshBasicMaterial) {
        const base = (b.mesh.userData.baseOpacity as number | undefined) ?? 0.38
        if (b.mesh.userData.baseOpacity == null) b.mesh.userData.baseOpacity = base
        const pulse = 0.88 + Math.abs(Math.sin(this.animTime * 0.0008 + b.mesh.position.x * 0.3)) * 0.12
        b.mesh.material.opacity = base * pulse
      }
      if (b.mesh.position.z > this.camera.position.z + 15) {
        b.mesh.position.set(
          (Math.random() - 0.5) * 140,
          (Math.random() - 0.5) * 70,
          this.camera.position.z - 155 - Math.random() * 30
        )
      }
    }

    this.pt1.position.set(
      Math.sin(this.camT * 0.8) * 25 + this.camera.position.x,
      Math.cos(this.camT * 0.6) * 12 + this.camera.position.y,
      this.camera.position.z - 18
    )
    this.pt2.position.set(
      Math.cos(this.camT * 0.5) * 20 + this.camera.position.x,
      Math.sin(this.camT * 0.9) * 15 + this.camera.position.y,
      this.camera.position.z - 30
    )
    this.galaxy.rotation.y += dt * 0.006 * blockMotion
    this.nebula.rotation.y -= dt * 0.003 * blockMotion
    this.stars.rotation.y += dt * 0.0004 * blockMotion
  }

  dispose() {
    this.disposed = true
    this.detachAssetsListener()
    this.scene.clear()
    this.bGeo.dispose()
    this.eGeo.dispose()
    this.galGeo.dispose()
    this.nebGeo.dispose()
    this.gradientSkyTexture?.dispose()
    this.atlasTexture?.dispose()
    for (const mat of this.blockMaterialPool.values()) {
      mat.map?.dispose()
      mat.dispose()
    }
    this.blockMaterialPool.clear()
  }
}
