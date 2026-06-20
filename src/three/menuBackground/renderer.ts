import * as THREE from 'three'
import type { GraphicsInitOptions } from '../../graphicsBackend/types'
import type { DocumentRenderer } from '../documentRenderer'
import { ClassicMenuBackground } from './classic'
import { V2MenuBackground } from './v2'
import { WorldBlocksMenuBackground } from './worldBlocks'
import type { MenuBackgroundView } from './activeView'
import type { MenuBackgroundOptions } from './types'
import { resolveMenuBackgroundMode } from './types'

/**
 * Orchestrates main-menu background rendering (dispatches to classic / v2 / world-blocks).
 */
export class MenuBackgroundRenderer {
  private active?: MenuBackgroundView
  private readonly abortController = new AbortController()
  private readonly mode: ReturnType<typeof resolveMenuBackgroundMode>
  private lastFrameTime = 0

  constructor(
    private readonly documentRenderer: DocumentRenderer,
    private readonly options: GraphicsInitOptions,
    menuBackgroundOptions: MenuBackgroundOptions = {},
    singleFileBuild = false
  ) {
    this.mode = resolveMenuBackgroundMode(menuBackgroundOptions, singleFileBuild)
  }

  /** Active v2 instance when that style is running. */
  get v2(): V2MenuBackground | undefined {
    return this.active instanceof V2MenuBackground ? this.active : undefined
  }

  get scene(): THREE.Scene | undefined {
    return this.active?.scene
  }

  get camera(): THREE.PerspectiveCamera | undefined {
    return this.active?.camera
  }

  async start(menuBackgroundOptions: MenuBackgroundOptions = {}) {
    this.active = this.createImplementation(menuBackgroundOptions)
    await this.active.init()

    if (this.active.scene.background instanceof THREE.Color) {
      this.documentRenderer.renderer.setClearColor(this.active.scene.background)
    }

    this.lastFrameTime = performance.now()
    this.documentRenderer.render = (sizeChanged = false) => {
      const now = performance.now()
      const dt = Math.min((now - this.lastFrameTime) / 1000, 0.05)
      this.lastFrameTime = now

      const view = this.active
      if (!view) return

      view.update(dt, sizeChanged)
      this.documentRenderer.renderer.render(view.scene, view.camera)
    }
  }

  private createImplementation(options: MenuBackgroundOptions): MenuBackgroundView {
    switch (this.mode) {
      case 'v2':
        return new V2MenuBackground(
          this.documentRenderer,
          {
            useMinecraftTextures: options.useMinecraftTextures,
            initialScene: options.v2Scene,
            initialCamera: options.v2Camera,
            initialBlockGroup: options.v2BlockGroup,
            initialCameraSpeed: options.v2CameraSpeed,
            initialBlockSpeed: options.v2BlockSpeed,
            resourcesManager: options.resourcesManager
          },
          this.abortController.signal
        )
      case 'worldBlocks':
        return new WorldBlocksMenuBackground(this.documentRenderer, this.options, this.abortController.signal)
      default:
        return new ClassicMenuBackground(this.documentRenderer)
    }
  }

  dispose() {
    this.active?.dispose()
    this.active = undefined
    this.abortController.abort()
  }
}
