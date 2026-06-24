import * as THREE from 'three'
import { Vec3 } from 'vec3'
import * as tweenJs from '@tweenjs/tween.js'
import { getSyncWorld } from '../../playground/shared'
import type { GraphicsInitOptions } from '../../graphicsBackend/types'
import { WorldRendererCommon } from '../../lib/worldrendererCommon'
import { defaultWorldRendererConfig, getDefaultRendererState } from '../../graphicsBackend/config'
import { ResourcesManager, ResourcesManagerTransferred } from '../../resourcesManager/resourcesManager'
import { getInitialPlayerStateRenderer } from '../../graphicsBackend/playerState'
import { WorldRendererThree } from '../worldRendererThree'
import type { DocumentRenderer } from '../documentRenderer'
import { MENU_BACKGROUND_MC_VERSION } from './shared'
import { WorldView } from '../../worldView'
import type { MenuBackgroundView } from './activeView'
import { resizeMenuBackgroundCamera } from './activeView'

/**
 * Menu background built from a wall of random stained-glass blocks (single-file / demo style).
 */
export class WorldBlocksMenuBackground implements MenuBackgroundView {
  private _scene: THREE.Scene
  private _camera: THREE.PerspectiveCamera

  get scene() {
    return this._scene
  }
  get camera() {
    return this._camera
  }

  private worldRenderer?: WorldRendererCommon | WorldRendererThree
  WorldRendererClass = WorldRendererThree

  constructor(
    private readonly documentRenderer: DocumentRenderer,
    private readonly options: GraphicsInitOptions,
    private readonly abortSignal: AbortSignal
  ) {
    this._scene = new THREE.Scene()
    this._scene.background = new THREE.Color(0x32_45_68)
    this._camera = new THREE.PerspectiveCamera(85, documentRenderer.canvas.width / documentRenderer.canvas.height, 0.05, 1000)
    this.camera.position.set(0, 0, 0)
    this.camera.rotation.set(0, 0, 0)
  }

  async init() {
    const version = MENU_BACKGROUND_MC_VERSION
    const fullResourceManager = new ResourcesManager()
    fullResourceManager.currentConfig = { version, noInventoryGui: true }
    await fullResourceManager.updateAssetsData?.({})
    if (this.abortSignal.aborted) return

    console.time('load menu background scene')
    const world = getSyncWorld(version)
    const PrismarineBlock = require('prismarine-block')
    const Block = PrismarineBlock(version)
    const mcData = (globalThis as any).mcData
    const fullBlocks = mcData.blocksArray.filter((block: { name: string; defaultState: number }) => {
      if (!block.name.includes('stained_glass')) return false
      const b = Block.fromStateId(block.defaultState, 0)
      if (b.shapes?.length !== 1) return false
      const shape = b.shapes[0]
      return shape[0] === 0 && shape[1] === 0 && shape[2] === 0 && shape[3] === 1 && shape[4] === 1 && shape[5] === 1
    })

    const Z = -15
    const sizeX = 100
    const sizeY = 100
    for (let x = -sizeX; x < sizeX; x++) {
      for (let y = -sizeY; y < sizeY; y++) {
        const block = fullBlocks[Math.floor(Math.random() * fullBlocks.length)]
        world.setBlockStateId(new Vec3(x, y, Z), block.defaultState)
      }
    }

    this._camera.updateProjectionMatrix()
    this._camera.position.set(0.5, sizeY / 2 + 0.5, 0.5)
    this._camera.rotation.set(0, 0, 0)
    const initPos = new Vec3(...this._camera.position.toArray())
    const worldView = new WorldView(world, 2, initPos)
    if (this.abortSignal.aborted) return

    this.worldRenderer = new this.WorldRendererClass(this.documentRenderer.renderer, this.options, {
      version,
      worldView,
      inWorldRenderingConfig: defaultWorldRendererConfig,
      playerStateReactive: getInitialPlayerStateRenderer().reactive,
      rendererState: getDefaultRendererState().reactive,
      nonReactiveState: getDefaultRendererState().nonReactive,
      resourcesManager: fullResourceManager as ResourcesManagerTransferred
    })

    if (this.worldRenderer instanceof WorldRendererThree) {
      this._scene = this.worldRenderer.realScene
      this._camera = this.worldRenderer.camera
    }

    void worldView.init(initPos)
    await this.worldRenderer.waitForChunksToRender()
    if (this.abortSignal.aborted) return

    this.setupMouseParallax()
    console.timeEnd('load menu background scene')
  }

  update(_dt: number, sizeChanged: boolean) {
    if (sizeChanged) {
      resizeMenuBackgroundCamera(this.camera, this.documentRenderer.canvas)
    }
  }

  dispose() {
    this.worldRenderer?.destroy()
    this.worldRenderer = undefined
    this._scene.clear()
  }

  private setupMouseParallax() {
    const camera = this._camera
    const initX = camera.position.x
    const initY = camera.position.y
    let prevTween: tweenJs.Tween<THREE.Vector3> | undefined

    document.body.addEventListener(
      'pointermove',
      e => {
        if (e.pointerType !== 'mouse') return
        const SCALE = 0.2
        const xRel = e.clientX / window.innerWidth - 0.5
        const yRel = -(e.clientY / window.innerHeight - 0.5)
        prevTween?.stop()
        prevTween = new tweenJs.Tween(camera.position).to(
          {
            x: initX + xRel * SCALE,
            y: initY + yRel * SCALE
          },
          0
        )
        prevTween.start()
        camera.updateProjectionMatrix()
      },
      { signal: this.abortSignal }
    )
  }
}
