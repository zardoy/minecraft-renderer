/* eslint-disable unicorn/prefer-dom-node-text-content */
import { isWebWorker } from '../../three/documentRenderer'

const rightOffset = 0

const stats = {}

let lastY = 40

/** Class for advanced stats pane; host app should set z-index (see integrating app global CSS). */
export const MC_RENDERER_DEBUG_OVERLAY_CLASS = 'mc-renderer-debug-overlay'

const STACK_CLASS = 'mc-renderer-debug-stack'
const STACK_STYLE_ID = 'mc-renderer-debug-stack-style'
/** Viewport width below which the advanced stats stack in one column (they are separate fixed panes beside each other otherwise). */
const NARROW_STACK_PX = 520

/**
 * Advanced stats panes live in one wrapper. On wide screens it is `display: contents`: nothing changes, every pane keeps its own fixed
 * position. On narrow screens (phones) the wrapper becomes the fixed column and the panes stack in it, below the host's top button
 * row (`--mc-renderer-debug-top`, default 44px) instead of overlapping it and each other. The wrapper has the overlay class as well,
 * so the host's z-index rules for that class (and its "under modals" variant) apply to the whole column.
 */
const getDebugStack = () => {
  let stack = document.querySelector<HTMLDivElement>(`.${STACK_CLASS}`)
  if (stack) return stack
  if (!document.getElementById(STACK_STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STACK_STYLE_ID
    style.textContent = `
.${STACK_CLASS} { display: contents; }
@media (max-width: ${NARROW_STACK_PX - 1}px) {
  .${STACK_CLASS} {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    position: fixed;
    top: var(--mc-renderer-debug-top, 44px);
    right: 0;
    max-width: 100vw;
    pointer-events: none;
  }
  .${STACK_CLASS} > .${MC_RENDERER_DEBUG_OVERLAY_CLASS} {
    position: static !important;
    top: auto !important;
    right: auto !important;
    max-width: 100%;
    box-sizing: border-box;
  }
}`
    document.head.appendChild(style)
  }
  stack = document.createElement('div')
  stack.className = `${STACK_CLASS} ${MC_RENDERER_DEBUG_OVERLAY_CLASS}`
  document.body.appendChild(stack)
  return stack
}

export const addNewStat = (id: string, width = 80, x = rightOffset, y = lastY, opts?: { className?: string }) => {
  if (isWebWorker) return { updateText() {}, setVisibility() {} }

  const pane = document.createElement('div')
  pane.style.position = 'fixed'
  pane.style.top = `${y ?? lastY}px`
  pane.style.right = `${x}px`
  // gray bg
  pane.style.backgroundColor = 'rgba(0, 0, 0, 0.7)'
  pane.style.color = 'white'
  pane.style.padding = '2px'
  pane.style.fontFamily = 'monospace'
  pane.style.fontSize = '12px'
  if (opts?.className) {
    pane.className = opts.className
  } else {
    pane.style.zIndex = '100'
  }
  pane.style.pointerEvents = 'none'
  ;(opts?.className === MC_RENDERER_DEBUG_OVERLAY_CLASS ? getDebugStack() : document.body).appendChild(pane)
  stats[id] = pane
  if (y === undefined && x === rightOffset) {
    // otherwise it's a custom position
    // rightOffset += width
    lastY += 20
  }

  return {
    updateText(text: string) {
      if (pane.innerText === text) return
      pane.innerText = text
    },
    setVisibility(visible: boolean) {
      pane.style.display = visible ? 'block' : 'none'
    }
  }
}

export const addNewStat2 = (
  id: string,
  { top, bottom, right, left, displayOnlyWhenWider }: { top?: number; bottom?: number; right?: number; left?: number; displayOnlyWhenWider?: number }
) => {
  if (isWebWorker) return { updateText() {}, setVisibility() {} }

  if (top === undefined && bottom === undefined) top = 0
  const pane = document.createElement('div')
  pane.style.position = 'fixed'
  if (top !== undefined) {
    pane.style.top = `${top}px`
  }
  if (bottom !== undefined) {
    pane.style.bottom = `${bottom}px`
  }
  if (left !== undefined) {
    pane.style.left = `${left}px`
  }
  if (right !== undefined) {
    pane.style.right = `${right}px`
  }
  // gray bg
  pane.style.backgroundColor = 'rgba(0, 0, 0, 0.7)'
  pane.style.color = 'white'
  pane.style.padding = '2px'
  pane.style.fontFamily = 'monospace'
  pane.style.fontSize = '12px'
  pane.style.zIndex = '10000'
  pane.style.pointerEvents = 'none'
  document.body.appendChild(pane)
  stats[id] = pane

  const resizeCheck = () => {
    if (!displayOnlyWhenWider) return
    pane.style.display = window.innerWidth > displayOnlyWhenWider ? 'block' : 'none'
  }
  window.addEventListener('resize', resizeCheck)
  resizeCheck()

  return {
    updateText(text: string) {
      pane.innerText = text
    },
    setVisibility(visible: boolean) {
      pane.style.display = visible ? 'block' : 'none'
    }
  }
}

export const updateStatText = (id, text) => {
  if (isWebWorker || !stats[id]) return
  stats[id].innerText = text
}

export const updatePanesVisibility = (visible: boolean) => {
  if (isWebWorker) return
  // eslint-disable-next-line guard-for-in
  for (const id in stats) {
    stats[id].style.display = visible ? 'block' : 'none'
  }
}

export const removeAllStats = () => {
  if (isWebWorker) return
  // eslint-disable-next-line guard-for-in
  for (const id in stats) {
    removeStat(id)
  }
}

export const removeStat = id => {
  if (isWebWorker || !stats[id]) return
  stats[id].remove()
  delete stats[id]
}
