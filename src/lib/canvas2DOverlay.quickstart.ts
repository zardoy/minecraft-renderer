/**
 * QUICK START: Add a black 100px box at bottom-left corner
 *
 * This is the minimal code needed to render 2D graphics on your Three.js canvas.
 * Works in both main thread and Web Workers!
 */

import { DocumentRenderer } from '../three/documentRenderer'
import { Canvas2DOverlay } from './canvas2DOverlay'

// ============================================
// STEP 1: Create the overlay
// ============================================
export function addBlackBoxOverlay(documentRenderer: DocumentRenderer) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  // ============================================
  // STEP 2: Hook into the render loop
  // ============================================
  documentRenderer.onRender.push(sizeChanged => {
    // Update overlay camera when canvas size changes
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    // Clear previous frame's overlay
    overlay.clear()

    // ============================================
    // STEP 3: Draw your 2D elements
    // ============================================

    // Black box at bottom-left corner (100x100 pixels)
    const boxSize = 100
    const x = 10 // 10px from left edge
    const y = documentRenderer.canvas.height - boxSize - 10 // 10px from bottom

    overlay.drawRect(
      x, // x position
      y, // y position
      boxSize, // width
      boxSize, // height
      0x000000, // color (black)
      0.8 // opacity (80%)
    )

    // ============================================
    // STEP 4: Render the overlay
    // ============================================
    overlay.render()
  })

  return overlay
}

// ============================================
// Usage Example
// ============================================
/*

In your viewer initialization code:

```typescript
import { addBlackBoxOverlay } from './lib/canvas2DOverlay.quickstart'

// After creating documentRenderer:
const overlay = addBlackBoxOverlay(documentRenderer)

// That's it! The black box will now render on every frame.
```

*/

// ============================================
// Add More Elements
// ============================================
export function addMultipleElements(documentRenderer: DocumentRenderer) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    overlay.clear()

    // Bottom-left black box
    const boxSize = 100
    overlay.drawRect(10, documentRenderer.canvas.height - boxSize - 10, boxSize, boxSize, 0x000000, 0.8)

    // Add label inside the box
    overlay.drawText('Info', 15, documentRenderer.canvas.height - boxSize, {
      fontSize: 14,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })

    // Top-right red box
    overlay.drawRect(
      documentRenderer.canvas.width - 60,
      10,
      50,
      50,
      0xff0000, // red
      0.9
    )

    // Bottom-center health bar style
    const barWidth = 200
    const barHeight = 20
    const barX = (documentRenderer.canvas.width - barWidth) / 2
    const barY = documentRenderer.canvas.height - 30

    // Background
    overlay.drawRect(barX, barY, barWidth, barHeight, 0x333333, 0.8)
    // Filled portion (e.g., 75% health)
    overlay.drawRect(barX, barY, barWidth * 0.75, barHeight, 0x00ff00, 0.9)
    // Border
    overlay.drawRectOutline(barX, barY, barWidth, barHeight, 0xffffff, 2)

    overlay.render()
  })

  return overlay
}

// ============================================
// Dynamic Data Example
// ============================================
export function addDynamicOverlay(documentRenderer: DocumentRenderer, getData: () => { fps: number; x: number; y: number; z: number }) {
  const overlay = new Canvas2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(sizeChanged => {
    if (sizeChanged) {
      overlay.updateSize(documentRenderer.canvas.width, documentRenderer.canvas.height)
    }

    const data = getData() // Get current game data

    overlay.clear()

    // Info panel at bottom-left
    const panelX = 10
    const panelY = documentRenderer.canvas.height - 120
    const panelWidth = 180
    const panelHeight = 110

    // Background
    overlay.drawRect(panelX, panelY, panelWidth, panelHeight, 0x000000, 0.7)

    // FPS (colored based on value)
    const fpsColor = data.fps > 50 ? '#00ff00' : data.fps > 30 ? '#ffff00' : '#ff0000'
    overlay.drawText(`FPS: ${data.fps}`, panelX + 10, panelY + 10, {
      fontSize: 16,
      color: fpsColor,
      backgroundColor: 'transparent'
    })

    // Coordinates
    overlay.drawText(`X: ${data.x.toFixed(2)}`, panelX + 10, panelY + 40, {
      fontSize: 14,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })
    overlay.drawText(`Y: ${data.y.toFixed(2)}`, panelX + 10, panelY + 60, {
      fontSize: 14,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })
    overlay.drawText(`Z: ${data.z.toFixed(2)}`, panelX + 10, panelY + 80, {
      fontSize: 14,
      color: '#ffffff',
      backgroundColor: 'transparent'
    })

    overlay.render()
  })

  return overlay
}

// ============================================
// High-Performance WebGL Version
// ============================================
import { WebGLDirect2DOverlay } from './canvas2DOverlay'

export function addHighPerformanceOverlay(documentRenderer: DocumentRenderer) {
  const overlay = new WebGLDirect2DOverlay(documentRenderer.renderer, documentRenderer.canvas)

  documentRenderer.onRender.push(() => {
    // Direct WebGL rendering - very fast!
    // No need to clear or call render() - draws immediately

    // Black box at bottom-left (r, g, b, a values 0-1)
    const boxSize = 100
    const x = 10
    const y = documentRenderer.canvas.height - boxSize - 10

    overlay.drawRect(
      x, // x
      y, // y
      boxSize, // width
      boxSize, // height
      0, // red (0-1)
      0, // green (0-1)
      0, // blue (0-1)
      0.8 // alpha (0-1)
    )
  })

  return overlay
}
