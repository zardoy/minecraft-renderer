/**
 * EXAMPLES: How to use Canvas2DOverlay with Three.js
 * Works in both main thread and Web Workers!
 */

import * as THREE from 'three'
import { DocumentRenderer } from '../three/documentRenderer'
import { Canvas2DOverlay, WebGLDirect2DOverlay } from './canvas2DOverlay'

// ============================================
// EXAMPLE 1: Simple Black Box (100px) at Bottom Left
// ============================================
export function example1_SimpleBlackBox(documentRenderer: DocumentRenderer) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  // Register to render overlay after main scene
  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    overlay.clear()

    // Draw black box at bottom-left corner
    // Position is from TOP-left, so for bottom we calculate from height
    const boxSize = 100
    const x = 10 // 10px from left
    const y = documentRenderer.canvas.height - boxSize - 10 // 10px from bottom

    overlay.drawRect(x, y, boxSize, boxSize, 0x000000, 0.8) // Black with 80% opacity

    overlay.render()
  })

  return overlay
}

// ============================================
// EXAMPLE 2: FPS Counter with Background
// ============================================
export function example2_FPSCounter(documentRenderer: DocumentRenderer) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  let fps = 0
  let lastTime = performance.now()
  let frameCount = 0

  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    // Calculate FPS
    frameCount++
    const now = performance.now()
    if (now - lastTime >= 1000) {
      fps = Math.round((frameCount * 1000) / (now - lastTime))
      frameCount = 0
      lastTime = now
    }

    overlay.clear()

    // Background box
    overlay.drawRect(10, 10, 120, 40, 0x000000, 0.7)

    // FPS text
    overlay.drawText(`FPS: ${fps}`, 15, 15, {
      fontSize: 20,
      color: fps > 50 ? '#00ff00' : fps > 30 ? '#ffff00' : '#ff0000',
      backgroundColor: 'transparent',
      opacity: 1
    })

    overlay.render()
  })

  return overlay
}

// ============================================
// EXAMPLE 3: Coordinate Display (Bottom-Left)
// ============================================
export function example3_CoordinateDisplay(documentRenderer: DocumentRenderer, getPosition: () => { x: number; y: number; z: number }) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    const pos = getPosition()

    overlay.clear()

    // Bottom-left position display
    const x = 10
    const y = documentRenderer.canvas.height - 100

    // Background
    overlay.drawRect(x, y, 200, 80, 0x000000, 0.8)

    // Coordinate text
    overlay.drawText(`X: ${pos.x.toFixed(2)}`, x + 10, y + 10, {
      fontSize: 16,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })
    overlay.drawText(`Y: ${pos.y.toFixed(2)}`, x + 10, y + 35, {
      fontSize: 16,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })
    overlay.drawText(`Z: ${pos.z.toFixed(2)}`, x + 10, y + 60, {
      fontSize: 16,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })

    overlay.render()
  })

  return overlay
}

// ============================================
// EXAMPLE 4: Mini-map (Top-Right Corner)
// ============================================
export function example4_MiniMap(documentRenderer: DocumentRenderer, playerPos: { x: number; z: number }) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    overlay.clear()

    const mapSize = 150
    const x = documentRenderer.canvas.width - mapSize - 10
    const y = 10

    // Background
    overlay.drawRect(x, y, mapSize, mapSize, 0x1a1a1a, 0.9)

    // Border
    overlay.drawRectOutline(x, y, mapSize, mapSize, 0x666666, 2)

    // Player position (center dot)
    const centerX = x + mapSize / 2
    const centerY = y + mapSize / 2
    overlay.drawCircle(centerX, centerY, 5, 0xff0000, 1)

    // Compass directions
    overlay.drawText('N', centerX - 5, y + 5, {
      fontSize: 12,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })

    overlay.render()
  })

  return overlay
}

// ============================================
// EXAMPLE 5: Performance WebGL Direct Rendering
// ============================================
export function example5_DirectWebGL(documentRenderer: DocumentRenderer) {
  const overlay = new WebGLDirect2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(() => {
    // This renders directly with WebGL - very fast!
    // After Three.js renders, draw on top

    // Black box at bottom-left
    overlay.drawRect(10, documentRenderer.canvas.height - 110, 100, 100, 0, 0, 0, 0.8)

    // Red box at top-left
    overlay.drawRect(10, 10, 50, 50, 1, 0, 0, 1)

    // Semi-transparent blue box
    overlay.drawRect(70, 10, 50, 50, 0, 0, 1, 0.5)
  })

  return overlay
}

// ============================================
// EXAMPLE 6: Health/Status Bar
// ============================================
export function example6_HealthBar(documentRenderer: DocumentRenderer, getHealth: () => { current: number; max: number }) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    const health = getHealth()
    const healthPercent = health.current / health.max

    overlay.clear()

    // Position at bottom center
    const barWidth = 200
    const barHeight = 20
    const x = (documentRenderer.canvas.width - barWidth) / 2
    const y = documentRenderer.canvas.height - barHeight - 20

    // Background (dark gray)
    overlay.drawRect(x, y, barWidth, barHeight, 0x333333, 0.8)

    // Health bar (red to green based on health)
    const healthBarWidth = barWidth * healthPercent
    const color = healthPercent > 0.5 ? 0x00ff00 : healthPercent > 0.25 ? 0xffff00 : 0xff0000
    overlay.drawRect(x, y, healthBarWidth, barHeight, color, 0.9)

    // Border
    overlay.drawRectOutline(x, y, barWidth, barHeight, 0xffffff, 2)

    // Text
    overlay.drawText(`${health.current}/${health.max}`, x + barWidth / 2 - 30, y + 2, {
      fontSize: 14,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })

    overlay.render()
  })

  return overlay
}

// ============================================
// EXAMPLE 7: Debug Grid Overlay
// ============================================
export function example7_DebugGrid(documentRenderer: DocumentRenderer) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    overlay.clear()

    const gridSize = 50
    const width = documentRenderer.canvas.width
    const height = documentRenderer.canvas.height

    // Draw vertical lines
    for (let x = 0; x < width; x += gridSize) {
      const points = [new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, height, 0)]
      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      const material = new THREE.LineBasicMaterial({ color: 0x333333, opacity: 0.3, transparent: true })
      const line = new THREE.Line(geometry, material)
      overlay['overlayScene'].add(line)
      overlay['overlayObjects'].push(line as any)
    }

    // Draw horizontal lines
    for (let y = 0; y < height; y += gridSize) {
      const points = [new THREE.Vector3(0, y, 0), new THREE.Vector3(width, y, 0)]
      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      const material = new THREE.LineBasicMaterial({ color: 0x333333, opacity: 0.3, transparent: true })
      const line = new THREE.Line(geometry, material)
      overlay['overlayScene'].add(line)
      overlay['overlayObjects'].push(line as any)
    }

    overlay.render()
  })

  return overlay
}

// ============================================
// EXAMPLE 8: Simple Usage in DocumentRenderer
// ============================================
export function integrateWithDocumentRenderer(documentRenderer: DocumentRenderer) {
  // Method 1: Using Three.js-based overlay (easier, more features)
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  // Add to render loop
  const originalRender = documentRenderer.render
  documentRenderer.render = sizeChanged => {
    // Call original render
    originalRender.call(documentRenderer, sizeChanged)

    // Update overlay size if needed
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    // Clear previous frame
    overlay.clear()

    // Draw your 2D elements
    const boxSize = 100
    const x = 10
    const y = documentRenderer.canvas.height - boxSize - 10
    overlay.drawRect(x, y, boxSize, boxSize, 0x000000, 0.8)

    // Render overlay
    overlay.render()
  }

  return overlay
}

// ============================================
// EXAMPLE 9: Worker-Compatible Usage
// ============================================
export function workerCompatibleOverlay(documentRenderer: DocumentRenderer) {
  // This works the same in both main thread and worker!
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    overlay.clear()

    // Bottom-left black box
    overlay.drawRect(10, documentRenderer.canvas.height - 110, 100, 100, 0x000000, 0.8)

    // Add some text (works in worker because we use OffscreenCanvas!)
    overlay.drawText('Worker Render', 15, documentRenderer.canvas.height - 100, {
      fontSize: 12,
      color: '#00ff00',
      backgroundColor: 'transparent'
    })

    overlay.render()
  })

  return overlay
}
