/**
 * Canvas 2D Overlay for Three.js WebGL Canvas
 *
 * Provides methods to draw 2D graphics on top of Three.js rendering
 * Works in both main thread and Web Worker contexts (OffscreenCanvas)
 */

import * as THREE from 'three'

export class Canvas2DOverlay {
  private gl: WebGLRenderingContext | WebGL2RenderingContext
  private overlayScene: THREE.Scene
  private overlayCamera: THREE.OrthographicCamera
  private overlayObjects: THREE.Mesh[] = []

  constructor(
    private renderer: THREE.WebGLRenderer,
    private canvas: HTMLCanvasElement | OffscreenCanvas
  ) {
    this.gl = this.renderer.getContext()

    // Setup orthographic camera for 2D overlay
    this.overlayCamera = new THREE.OrthographicCamera(
      0, // left
      this.canvas.width, // right
      this.canvas.height, // top
      0, // bottom
      0.1, // near
      1000 // far
    )
    this.overlayCamera.position.z = 10

    this.overlayScene = new THREE.Scene()
  }

  /**
   * Update camera when canvas size changes
   */
  updateSize(width: number, height: number) {
    this.overlayCamera.left = 0
    this.overlayCamera.right = width
    this.overlayCamera.top = height
    this.overlayCamera.bottom = 0
    this.overlayCamera.updateProjectionMatrix()
  }

  /**
   * Clear all overlay objects
   */
  clear() {
    for (const obj of this.overlayObjects) {
      obj.geometry.dispose()
      if (obj.material instanceof THREE.Material) {
        obj.material.dispose()
      }
      this.overlayScene.remove(obj)
    }
    this.overlayObjects = []
  }

  /**
   * Draw a filled rectangle (2D box)
   * @param x X position (pixels from left)
   * @param y Y position (pixels from top)
   * @param width Width in pixels
   * @param height Height in pixels
   * @param color Color (hex or CSS color)
   * @param opacity Opacity (0-1)
   */
  drawRect(x: number, y: number, width: number, height: number, color: number | string = 0x000000, opacity = 1) {
    const geometry = new THREE.PlaneGeometry(width, height)
    const material = new THREE.MeshBasicMaterial({
      color: typeof color === 'string' ? new THREE.Color(color) : color,
      transparent: opacity < 1,
      opacity,
      depthTest: false, // Always render on top
      depthWrite: false
    })

    const mesh = new THREE.Mesh(geometry, material)

    // Position: origin is top-left for pixel coordinates
    mesh.position.set(
      x + width / 2, // Center X
      y + height / 2, // Center Y (from top)
      0
    )

    this.overlayScene.add(mesh)
    this.overlayObjects.push(mesh)

    return mesh
  }

  /**
   * Draw a rectangle outline (border only)
   */
  drawRectOutline(x: number, y: number, width: number, height: number, color: number | string = 0x000000, lineWidth = 1, opacity = 1) {
    const points = [
      new THREE.Vector3(x, y, 0),
      new THREE.Vector3(x + width, y, 0),
      new THREE.Vector3(x + width, y + height, 0),
      new THREE.Vector3(x, y + height, 0),
      new THREE.Vector3(x, y, 0)
    ]

    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = new THREE.LineBasicMaterial({
      color: typeof color === 'string' ? new THREE.Color(color) : color,
      transparent: opacity < 1,
      opacity,
      linewidth: lineWidth // Note: linewidth may not work on all platforms
    })

    const line = new THREE.Line(geometry, material)
    this.overlayScene.add(line)
    this.overlayObjects.push(line as any)

    return line
  }

  /**
   * Draw text using canvas texture (works in worker with OffscreenCanvas)
   */
  drawText(
    text: string,
    x: number,
    y: number,
    options: {
      fontSize?: number
      fontFamily?: string
      color?: string
      backgroundColor?: string
      padding?: number
      opacity?: number
    } = {}
  ) {
    const { fontSize = 16, fontFamily = 'Arial', color = '#ffffff', backgroundColor = '#000000', padding = 4, opacity = 1 } = options

    // Create a temporary canvas for text rendering
    // OffscreenCanvas works in workers!
    const textCanvas = new OffscreenCanvas(512, 128)
    const ctx = textCanvas.getContext('2d')!

    ctx.font = `${fontSize}px ${fontFamily}`
    const metrics = ctx.measureText(text)
    const textWidth = metrics.width
    const textHeight = fontSize

    // Resize canvas to fit text
    textCanvas.width = Math.ceil(textWidth + padding * 2)
    textCanvas.height = Math.ceil(textHeight + padding * 2)

    // Redraw with proper size
    ctx.font = `${fontSize}px ${fontFamily}`
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, textCanvas.width, textCanvas.height)

    ctx.fillStyle = color
    ctx.textBaseline = 'top'
    ctx.fillText(text, padding, padding)

    // Create texture from canvas
    const texture = new THREE.CanvasTexture(textCanvas as any)
    texture.needsUpdate = true

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false
    })

    const geometry = new THREE.PlaneGeometry(textCanvas.width, textCanvas.height)
    const mesh = new THREE.Mesh(geometry, material)

    mesh.position.set(x + textCanvas.width / 2, y + textCanvas.height / 2, 0)

    this.overlayScene.add(mesh)
    this.overlayObjects.push(mesh)

    return mesh
  }

  /**
   * Draw a circle
   */
  drawCircle(x: number, y: number, radius: number, color: number | string = 0x000000, opacity = 1) {
    const geometry = new THREE.CircleGeometry(radius, 32)
    const material = new THREE.MeshBasicMaterial({
      color: typeof color === 'string' ? new THREE.Color(color) : color,
      transparent: opacity < 1,
      opacity,
      depthTest: false,
      depthWrite: false
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(x, y, 0)

    this.overlayScene.add(mesh)
    this.overlayObjects.push(mesh)

    return mesh
  }

  /**
   * Render the overlay on top of Three.js scene
   * Call this after rendering your main 3D scene
   */
  render() {
    // Disable depth test so overlay renders on top
    const oldAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false

    this.renderer.render(this.overlayScene, this.overlayCamera)

    this.renderer.autoClear = oldAutoClear
  }

  /**
   * Dispose of all resources
   */
  dispose() {
    this.clear()
    this.overlayScene.clear()
  }
}

/**
 * Alternative: Direct WebGL 2D Drawing
 * For more performance or if you need more control
 */
export class WebGLDirect2DOverlay {
  private gl: WebGLRenderingContext | WebGL2RenderingContext
  private program: WebGLProgram
  private positionBuffer: WebGLBuffer
  private colorBuffer: WebGLBuffer

  constructor(
    private renderer: THREE.WebGLRenderer,
    private canvas: HTMLCanvasElement | OffscreenCanvas
  ) {
    this.gl = this.renderer.getContext()

    // Create shader program for 2D rendering
    const vertexShader = this.createShader(
      this.gl.VERTEX_SHADER,
      `
      attribute vec2 position;
      attribute vec4 color;
      varying vec4 vColor;
      uniform vec2 resolution;

      void main() {
        // Convert pixel coordinates to clip space (-1 to 1)
        vec2 clipSpace = (position / resolution) * 2.0 - 1.0;
        gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
        vColor = color;
      }
    `
    )

    const fragmentShader = this.createShader(
      this.gl.FRAGMENT_SHADER,
      `
      precision mediump float;
      varying vec4 vColor;

      void main() {
        gl_FragColor = vColor;
      }
    `
    )

    this.program = this.createProgram(vertexShader, fragmentShader)

    this.positionBuffer = this.gl.createBuffer()!
    this.colorBuffer = this.gl.createBuffer()!
  }

  private createShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type)!
    this.gl.shaderSource(shader, source)
    this.gl.compileShader(shader)

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error('Shader compilation error:', this.gl.getShaderInfoLog(shader))
      this.gl.deleteShader(shader)
      throw new Error('Shader compilation failed')
    }

    return shader
  }

  private createProgram(vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
    const program = this.gl.createProgram()!
    this.gl.attachShader(program, vertexShader)
    this.gl.attachShader(program, fragmentShader)
    this.gl.linkProgram(program)

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      console.error('Program linking error:', this.gl.getProgramInfoLog(program))
      throw new Error('Program linking failed')
    }

    return program
  }

  /**
   * Draw a rectangle using raw WebGL
   */
  drawRect(x: number, y: number, width: number, height: number, r: number, g: number, b: number, a = 1) {
    const x1 = x
    const y1 = y
    const x2 = x + width
    const y2 = y + height

    const positions = new Float32Array([x1, y1, x2, y1, x1, y2, x1, y2, x2, y1, x2, y2])

    const colors = new Float32Array([r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a, r, g, b, a])

    this.gl.useProgram(this.program)

    // Set resolution uniform
    const resolutionLocation = this.gl.getUniformLocation(this.program, 'resolution')
    this.gl.uniform2f(resolutionLocation, this.canvas.width, this.canvas.height)

    // Setup position attribute
    const positionLocation = this.gl.getAttribLocation(this.program, 'position')
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer)
    this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW)
    this.gl.enableVertexAttribArray(positionLocation)
    this.gl.vertexAttribPointer(positionLocation, 2, this.gl.FLOAT, false, 0, 0)

    // Setup color attribute
    const colorLocation = this.gl.getAttribLocation(this.program, 'color')
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.colorBuffer)
    this.gl.bufferData(this.gl.ARRAY_BUFFER, colors, this.gl.STATIC_DRAW)
    this.gl.enableVertexAttribArray(colorLocation)
    this.gl.vertexAttribPointer(colorLocation, 4, this.gl.FLOAT, false, 0, 0)

    // Enable blending for transparency
    this.gl.enable(this.gl.BLEND)
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA)

    // Disable depth test to render on top
    this.gl.disable(this.gl.DEPTH_TEST)

    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6)

    // Restore state
    this.gl.enable(this.gl.DEPTH_TEST)
  }

  dispose() {
    this.gl.deleteBuffer(this.positionBuffer)
    this.gl.deleteBuffer(this.colorBuffer)
    this.gl.deleteProgram(this.program)
  }
}
