/**
 * Puts the page's 2D UI (HUD, pause menu, settings...) into an immersive VR session.
 *
 * Uses HTML-in-Canvas (Chrome 157+): while a session runs, the UI element is moved into the
 * renderer's canvas as a `drawable` child, uploaded into a texture with `texElementSubImage2D`
 * whenever it repaints, and shown on a quad that lazily follows the head. Controllers point at
 * the quad with a laser; the hit is mapped back to the element and turned into pointer / mouse /
 * click events, so the existing React UI works unchanged.
 *
 * Without the API (other browsers, older Chrome) this is a no-op and VR behaves as before.
 */
import * as THREE from 'three'

/** CSS size the UI is laid out at while in VR (a 16:9 "virtual screen"). */
/** The page's GUI scale (--guiScale) still applies inside, like on a 1280x720 window. */
const UI_WIDTH = 1280
const UI_HEIGHT = 720
/** Texture is rasterized at this multiple of the CSS size. */
const TEXTURE_SCALE = 1
/** Panel size in meters and distance from the head. */
const PANEL_WIDTH = 1.6
const PANEL_DISTANCE = 1.4
/** How quickly the panel catches up with head yaw (per second, exponential). */
const FOLLOW_SPEED = 3

type DrawableCanvas = HTMLCanvasElement & {
  requestPaint?: () => void
  updateElementGeometry?: (el: Element, options?: { canvasTransform?: DOMMatrixInit }) => void
}
type ElementGl = WebGL2RenderingContext & {
  texElementSubImage2D: (target: number, level: number, x: number, y: number, el: Element, config?: { width?: number; height?: number }) => void
}

export const isVrUiSupported = () => typeof WebGL2RenderingContext !== 'undefined' && 'texElementSubImage2D' in WebGL2RenderingContext.prototype

interface PointerState {
  controller: THREE.XRTargetRaySpace
  cursor: THREE.Mesh
  ray: THREE.Line
  hit: { x: number; y: number } | null
  pressed: boolean
  connected: boolean
  lastTarget: Element | null
}

export class VrUiPanel {
  readonly mesh: THREE.Mesh
  /** Wraps a GL texture this panel allocates itself, three only binds it. */
  private readonly texture = new THREE.ExternalTexture()
  private glTexture: WebGLTexture | null = null
  private readonly canvas: DrawableCanvas
  private element: HTMLElement | null = null
  private restore: (() => void) | null = null
  private dirty = false
  private placed = false
  private warnedNoPaint = false
  private lastPaintAt = 0
  private readonly pointers: PointerState[] = []
  private readonly raycaster = new THREE.Raycaster()
  private readonly tmpMatrix = new THREE.Matrix4()
  private readonly onPaint = (e: Event) => {
    const changed = (e as Event & { changedElements?: readonly Element[] }).changedElements
    if (!this.element) return
    if (!changed || changed.includes(this.element)) {
      this.dirty = true
      this.lastPaintAt = performance.now()
    }
  }

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    /** Group that holds the XR camera and controllers. */
    private readonly parent: THREE.Object3D
  ) {
    this.canvas = renderer.domElement as DrawableCanvas

    const geometry = new THREE.PlaneGeometry(PANEL_WIDTH, (PANEL_WIDTH * UI_HEIGHT) / UI_WIDTH)
    // Uploaded rows start at the element's top, so flip v: uv (0,0) is the element's top-left.
    const uv = geometry.attributes.uv!
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
    const material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })
    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.name = 'vr-ui-panel'
    this.mesh.renderOrder = 10_000
    this.mesh.visible = false

    for (let i = 0; i < 2; i++) this.pointers.push(this.createPointer(i))
  }

  private createPointer(index: number): PointerState {
    const controller = this.renderer.xr.getController(index)
    const cursor = new THREE.Mesh(
      new THREE.CircleGeometry(0.008, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 })
    )
    cursor.renderOrder = 10_001
    cursor.visible = false
    const ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false })
    )
    ray.renderOrder = 10_001
    ray.visible = false
    controller.add(ray)
    const state: PointerState = { controller, cursor, ray, hit: null, pressed: false, connected: false, lastTarget: null }
    controller.addEventListener('connected', () => {
      state.connected = true
    })
    controller.addEventListener('disconnected', () => {
      state.connected = false
    })
    controller.addEventListener('selectstart', () => {
      state.pressed = true
      if (state.hit) this.dispatchPress(state, true)
    })
    controller.addEventListener('selectend', () => {
      const wasPressed = state.pressed
      state.pressed = false
      if (wasPressed && state.hit) this.dispatchPress(state, false)
    })
    return state
  }

  get active() {
    return this.element !== null
  }

  /** Moves `element` into the canvas and starts showing it in VR. */
  attach(element: HTMLElement) {
    if (this.element || !isVrUiSupported()) return
    const { canvas } = this
    const parent = element.parentNode
    const next = element.nextSibling
    const prevStyle = element.getAttribute('style')
    const hadLayoutSubtree = canvas.hasAttribute('layoutsubtree')
    const prevContent = canvas.getAttribute('content')

    // `layoutsubtree` is the Chrome 155-156 spelling of `content="drawable"`.
    canvas.setAttribute('layoutsubtree', '')
    canvas.setAttribute('content', 'drawable')
    element.setAttribute('drawable', '')
    // Fixed size virtual screen. Keep a transform so position:fixed descendants stay inside it.
    element.style.setProperty('position', 'absolute')
    element.style.setProperty('left', '0')
    element.style.setProperty('top', '0')
    element.style.setProperty('width', `${UI_WIDTH}px`)
    element.style.setProperty('height', `${UI_HEIGHT}px`)
    element.style.setProperty('transform', 'scale(1)')
    canvas.appendChild(element)
    canvas.addEventListener('paint', this.onPaint)

    this.restore = () => {
      canvas.removeEventListener('paint', this.onPaint)
      element.removeAttribute('drawable')
      if (prevStyle === null) element.removeAttribute('style')
      else element.setAttribute('style', prevStyle)
      if (parent) parent.insertBefore(element, next && next.parentNode === parent ? next : null)
      if (!hadLayoutSubtree) canvas.removeAttribute('layoutsubtree')
      if (prevContent === null) canvas.removeAttribute('content')
      else canvas.setAttribute('content', prevContent)
    }

    this.element = element
    this.dirty = true
    this.placed = false
    this.lastPaintAt = performance.now()
    this.parent.add(this.mesh)
    for (const p of this.pointers) {
      this.parent.add(p.controller)
      this.parent.add(p.cursor)
    }
    canvas.requestPaint?.()
  }

  detach() {
    if (!this.element) return
    for (const p of this.pointers) {
      if (p.lastTarget) this.dispatchHover(p, null)
      p.hit = null
      p.cursor.visible = false
      p.ray.visible = false
      this.parent.remove(p.controller)
      this.parent.remove(p.cursor)
    }
    this.parent.remove(this.mesh)
    this.mesh.visible = false
    this.restore?.()
    this.restore = null
    this.element = null
  }

  /** Call once per XR frame, before rendering. */
  update(deltaSeconds: number) {
    if (!this.element) return
    this.followHead(deltaSeconds)
    this.upload()
    this.updatePointers()
  }

  private upload() {
    if (!this.dirty || !this.element) {
      if (!this.warnedNoPaint && performance.now() - this.lastPaintAt > 5000 && !this.mesh.visible) {
        this.warnedNoPaint = true
        console.warn('[vr-ui] no canvas paint event for 5s, the UI panel is not updating')
      }
      return
    }
    const gl = this.renderer.getContext() as ElementGl
    if (!this.glTexture) {
      const glTexture = gl.createTexture()
      this.renderer.state.bindTexture(gl.TEXTURE_2D, glTexture)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, UI_WIDTH * TEXTURE_SCALE, UI_HEIGHT * TEXTURE_SCALE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.glTexture = glTexture
      this.texture.sourceTexture = glTexture
    }
    try {
      this.renderer.state.bindTexture(gl.TEXTURE_2D, this.glTexture)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.element, {
        width: UI_WIDTH * TEXTURE_SCALE,
        height: UI_HEIGHT * TEXTURE_SCALE
      })
      this.dirty = false
      this.mesh.visible = true
      this.syncHitTestGeometry()
    } catch (err) {
      // No snapshot yet (first frames) - keep dirty and retry next frame.
      if (!(err instanceof DOMException && err.name === 'InvalidStateError')) throw err
    }
  }

  /**
   * Tell the browser where the element is "drawn" in canvas pixels, so its hit-test box matches
   * `pointToClient` and `elementsFromPoint` finds the right target.
   */
  private syncHitTestGeometry() {
    if (!this.element || !this.canvas.updateElementGeometry) return
    const rect = this.canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const k = this.cssScale(rect)
    const toCanvasPx = this.canvas.width / rect.width
    this.canvas.updateElementGeometry(this.element, { canvasTransform: new DOMMatrix().scale(k * toCanvasPx) })
  }

  private cssScale(rect: DOMRect) {
    return Math.min(rect.width / UI_WIDTH, rect.height / UI_HEIGHT)
  }

  private pointToClient(x: number, y: number) {
    const rect = this.canvas.getBoundingClientRect()
    const k = this.cssScale(rect)
    return { clientX: rect.left + x * k, clientY: rect.top + y * k }
  }

  private followHead(deltaSeconds: number) {
    const xrCamera = this.renderer.xr.getCamera()
    const headWorld = new THREE.Vector3().setFromMatrixPosition(xrCamera.matrixWorld)
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(xrCamera.matrixWorld))
    forward.y = 0
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1)
    forward.normalize()

    this.parent.updateWorldMatrix(true, false)
    const toLocal = this.tmpMatrix.copy(this.parent.matrixWorld).invert()
    const head = headWorld.clone().applyMatrix4(toLocal)
    const target = headWorld.clone().addScaledVector(forward, PANEL_DISTANCE).applyMatrix4(toLocal)
    target.y -= 0.15

    if (!this.placed) {
      this.mesh.position.copy(target)
      this.placed = true
    } else {
      const t = 1 - Math.exp(-FOLLOW_SPEED * deltaSeconds)
      this.mesh.position.lerp(target, t)
    }
    this.mesh.lookAt(head.applyMatrix4(this.parent.matrixWorld))
  }

  private updatePointers() {
    this.mesh.updateWorldMatrix(true, false)
    for (const p of this.pointers) {
      if (!this.mesh.visible || !p.connected) {
        p.ray.visible = false
        p.cursor.visible = false
        if (p.hit) this.leave(p)
        continue
      }
      this.tmpMatrix.identity().extractRotation(p.controller.matrixWorld)
      this.raycaster.ray.origin.setFromMatrixPosition(p.controller.matrixWorld)
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmpMatrix)
      const hit = this.raycaster.intersectObject(this.mesh, false)[0]
      p.ray.visible = true
      if (!hit?.uv) {
        p.ray.scale.z = 3
        p.cursor.visible = false
        if (p.hit) this.leave(p)
        continue
      }
      p.ray.scale.z = hit.distance
      p.cursor.visible = true
      p.cursor.position.copy(this.parent.worldToLocal(hit.point.clone()))
      p.cursor.quaternion.copy(this.mesh.quaternion)
      p.cursor.translateZ(0.002)
      const x = hit.uv.x * UI_WIDTH
      const y = hit.uv.y * UI_HEIGHT
      const moved = !p.hit || Math.abs(p.hit.x - x) > 0.5 || Math.abs(p.hit.y - y) > 0.5
      p.hit = { x, y }
      if (moved) this.dispatchMove(p)
    }
  }

  private targetAt(p: PointerState): Element | null {
    if (!p.hit || !this.element) return null
    const { clientX, clientY } = this.pointToClient(p.hit.x, p.hit.y)
    // Other page layers may sit above the canvas, take the topmost hit inside our element.
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      if (this.element.contains(el)) return el
    }
    return null
  }

  private eventInit(p: PointerState, buttons: number): PointerEventInit {
    const { clientX, clientY } = this.pointToClient(p.hit!.x, p.hit!.y)
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons,
      pointerId: 100 + this.pointers.indexOf(p),
      pointerType: 'mouse',
      isPrimary: true,
      view: window
    }
  }

  private dispatchMove(p: PointerState) {
    const target = this.targetAt(p)
    this.dispatchHover(p, target)
    if (!target) return
    const init = this.eventInit(p, p.pressed ? 1 : 0)
    target.dispatchEvent(new PointerEvent('pointermove', init))
    target.dispatchEvent(new MouseEvent('mousemove', init))
  }

  private dispatchHover(p: PointerState, target: Element | null) {
    if (p.lastTarget === target) return
    const init = p.hit ? this.eventInit(p, 0) : { bubbles: true, composed: true }
    if (p.lastTarget) {
      p.lastTarget.dispatchEvent(new PointerEvent('pointerout', init))
      p.lastTarget.dispatchEvent(new MouseEvent('mouseout', init))
      p.lastTarget.dispatchEvent(new PointerEvent('pointerleave', { ...init, bubbles: false }))
      p.lastTarget.dispatchEvent(new MouseEvent('mouseleave', { ...init, bubbles: false }))
    }
    if (target) {
      target.dispatchEvent(new PointerEvent('pointerover', init))
      target.dispatchEvent(new MouseEvent('mouseover', init))
      target.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false }))
      target.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }))
    }
    p.lastTarget = target
  }

  private pressTarget: Element | null = null

  private dispatchPress(p: PointerState, down: boolean) {
    const target = this.targetAt(p)
    if (!target) {
      if (!down) this.pressTarget = null
      return
    }
    const init = this.eventInit(p, down ? 1 : 0)
    if (down) {
      this.pressTarget = target
      target.dispatchEvent(new PointerEvent('pointerdown', init))
      target.dispatchEvent(new MouseEvent('mousedown', init))
      if (target instanceof HTMLElement) target.focus({ preventScroll: true })
      return
    }
    target.dispatchEvent(new PointerEvent('pointerup', init))
    target.dispatchEvent(new MouseEvent('mouseup', init))
    if (this.pressTarget && (this.pressTarget === target || this.pressTarget.contains(target) || target.contains(this.pressTarget))) {
      target.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }))
    }
    this.pressTarget = null
  }

  private leave(p: PointerState) {
    this.dispatchHover(p, null)
    p.hit = null
  }

  dispose() {
    this.detach()
    this.texture.dispose()
    if (this.glTexture) this.renderer.getContext().deleteTexture(this.glTexture)
    this.glTexture = null
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
