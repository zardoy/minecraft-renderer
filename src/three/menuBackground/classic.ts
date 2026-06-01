import * as THREE from 'three'
import { EntityMesh } from '../entity/EntityMesh'
import { loadImageFromUrl } from '../../lib/utils'
import type { DocumentRenderer } from '../documentRenderer'
import { loadThreeJsTextureFromBitmap } from '../threeJsUtils'
import type { MenuBackgroundView } from './activeView'
import { resizeMenuBackgroundCamera } from './activeView'
import { menuBackgroundAssetUrl } from './assetUrl'

const date = new Date()
const isChristmas = date.getMonth() === 11 && date.getDate() >= 24 && date.getDate() <= 26

const panoramaFiles = [
  'panorama_3.webp', // right (+x)
  'panorama_1.webp', // left (-x)
  'panorama_4.webp', // top (+y)
  'panorama_5.webp', // bottom (-y)
  'panorama_0.webp', // front (+z)
  'panorama_2.webp', // back (-z)
]

const FADE_IN_DURATION_MS = 200

/**
 * Vanilla-style rotating cubemap (Minecraft title-screen style) with optional squids.
 */
export class ClassicMenuBackground implements MenuBackgroundView {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera

  private readonly startTimes = new Map<THREE.MeshBasicMaterial, number>()
  private time = 0
  private panoramaGroup: THREE.Object3D | null = null

  constructor(private readonly documentRenderer: DocumentRenderer) {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x32_45_68)

    const ambient = new THREE.AmbientLight(0xcc_cc_cc)
    this.scene.add(ambient)
    const directional = new THREE.DirectionalLight(0xff_ff_ff, 0.5)
    directional.position.set(1, 1, 0.5).normalize()
    directional.castShadow = true
    this.scene.add(directional)

    this.camera = new THREE.PerspectiveCamera(
      85,
      documentRenderer.canvas.width / documentRenderer.canvas.height,
      0.05,
      1000
    )
    this.camera.position.set(0, 0, 0)
    this.camera.rotation.set(0, 0, 0)
  }

  async init() {
    this.buildCubemap()
  }

  update(_dt: number, sizeChanged: boolean) {
    if (sizeChanged) {
      resizeMenuBackgroundCamera(this.camera, this.documentRenderer.canvas)
    }
  }

  dispose() {
    this.scene.clear()
    this.panoramaGroup = null
    this.startTimes.clear()
  }

  private buildCubemap() {
    const panorGeo = new THREE.BoxGeometry(1000, 1000, 1000)
    const panorMaterials: THREE.MeshBasicMaterial[] = []

    for (const file of panoramaFiles) {
      const load = async () => {
        const url = menuBackgroundAssetUrl('background', isChristmas ? 'christmas' : '', file)
        const bitmap = await loadImageFromUrl(url)
        const texture = loadThreeJsTextureFromBitmap(bitmap)

        texture.matrixAutoUpdate = false
        texture.matrix.set(-1, 0, 1, 0, 1, 0, 0, 0, 1)
        texture.wrapS = THREE.ClampToEdgeWrapping
        texture.wrapT = THREE.ClampToEdgeWrapping
        texture.minFilter = THREE.LinearFilter
        texture.magFilter = THREE.LinearFilter

        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          opacity: 0
        })

        this.startTimes.set(material, Date.now())
        panorMaterials.push(material)
      }

      void load().catch(err => {
        console.warn('[ClassicMenuBackground] Failed to load panorama face:', file, err)
      })
    }

    const panoramaBox = new THREE.Mesh(panorGeo, panorMaterials)
    panoramaBox.onBeforeRender = () => {
      this.time += 0.01
      panoramaBox.rotation.y = Math.PI + this.time * 0.01
      panoramaBox.rotation.z = Math.sin(-this.time * 0.001) * 0.001

      for (const material of panorMaterials) {
        const startTime = this.startTimes.get(material)
        if (startTime) {
          const elapsed = Date.now() - startTime
          material.opacity = Math.min(1, elapsed / FADE_IN_DURATION_MS)
        }
      }
    }

    const group = new THREE.Object3D()
    group.add(panoramaBox)

    if (!isChristmas) {
      for (let i = 0; i < 20; i++) {
        const m = new EntityMesh('1.16.4', 'squid').mesh
        m.position.set(Math.random() * 30 - 15, Math.random() * 20 - 10, Math.random() * 10 - 17)
        m.rotation.set(0, Math.PI + Math.random(), -Math.PI / 4, 'ZYX')
        const v = Math.random() * 0.01
        m.children[0].onBeforeRender = () => {
          m.rotation.y += v
          m.rotation.z = Math.cos(panoramaBox.rotation.y * 3) * Math.PI / 4 - Math.PI / 2
        }
        group.add(m)
      }
    }

    this.scene.add(group)
    this.panoramaGroup = group
  }

  /** Debug helper: flat cubemap face in front of the camera. */
  async debugImageInFrontOfCamera() {
    const bitmap = await loadImageFromUrl(menuBackgroundAssetUrl('background', 'panorama_0.webp'))
    const image = loadThreeJsTextureFromBitmap(bitmap)
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.MeshBasicMaterial({ map: image })
    )
    mesh.position.set(0, 0, -500)
    this.scene.add(mesh)
  }
}
