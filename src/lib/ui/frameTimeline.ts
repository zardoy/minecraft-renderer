/**
 * Compact frame timeline: one column per rendered frame, scrolling left, so a stutter shows up
 * as a tall red column instead of disappearing into a 1 s FPS average.
 *
 * Frames are scored against the display's own refresh interval (measured from the frames
 * themselves), not fixed milliseconds: 20 ms is one dropped frame at 60 Hz but 2.5 at 120 Hz, so
 * fixed thresholds would paint the same stutter differently on different panels.
 *
 * Text line: `FPS/Hz · worst ms of the last 5 s`. The worst-frame number keeps a single
 * hitch readable after its column has already scrolled off the strip.
 */

const COL_W = 1
/** strips narrower than this drop the "/120Hz" part of the text */
const COMPACT_WIDTH_PX = 110
const WORST_WINDOW_MS = 5000
const VSYNC_RESAMPLE_FRAMES = 30

const GREEN = 'rgb(52, 211, 153)'
const YELLOW = 'rgb(250, 204, 21)'
const RED = 'rgb(239, 68, 68)'
const CPU = 'rgba(255, 255, 255, 0.35)'

export class FrameTimeline {
  readonly dom: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly text: HTMLDivElement
  private maxN: number
  /** Frame-to-frame interval (ms) and CPU time spent in the frame (ms), ring buffers. */
  private dts: Float32Array
  private cpus: Float32Array
  private head = 0
  private count = 0
  private lastStart = 0
  private frameStart = 0
  private vsyncMs = 16.67
  private frameCount = 0
  private fpsSmoothed = 60
  /** [timestamp, dt] of frames above one dropped vsync, for the "worst in 5 s" readout. */
  private recentWorst: Array<[number, number]> = []
  private lastTextUpdate = 0
  private visible = true

  constructor(
    private width = 160,
    private height = 30
  ) {
    this.maxN = Math.ceil(width / COL_W)
    this.dts = new Float32Array(this.maxN)
    this.cpus = new Float32Array(this.maxN)

    this.dom = document.createElement('div')
    this.dom.style.cssText = `position:relative;width:${width}px;height:${height}px;pointer-events:none;overflow:hidden;background:rgba(2,6,23,0.6);`
    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;'
    this.dom.appendChild(this.canvas)
    this.text = document.createElement('div')
    this.text.style.cssText =
      'position:absolute;left:3px;top:1px;font:700 10px/1 ui-monospace,Menlo,monospace;color:#e2e8f0;text-shadow:0 0 2px #000,0 0 1px #000;white-space:nowrap;'
    this.dom.appendChild(this.text)

    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** New size (narrow screens get a shorter strip). Drops the recorded history: its columns were drawn for the old width. */
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.maxN = Math.ceil(width / COL_W)
    this.dts = new Float32Array(this.maxN)
    this.cpus = new Float32Array(this.maxN)
    this.head = 0
    this.count = 0
    this.dom.style.width = `${width}px`
    this.dom.style.height = `${height}px`
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
    // assigning the canvas size resets the 2d context state
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return
    this.visible = visible
    this.dom.style.display = visible ? 'block' : 'none'
    // A hidden gap would read as one huge frame when it comes back.
    this.lastStart = 0
  }

  begin() {
    const now = performance.now()
    this.frameStart = now
    if (this.lastStart && this.visible) {
      this.push(now - this.lastStart, now)
    }
    this.lastStart = now
  }

  end() {
    if (!this.visible || this.count === 0) return
    const cpu = performance.now() - this.frameStart
    const last = (this.head - 1 + this.maxN) % this.maxN
    this.cpus[last] = cpu
    this.draw()
  }

  private push(dt: number, now: number) {
    this.dts[this.head] = dt
    this.cpus[this.head] = 0
    this.head = (this.head + 1) % this.maxN
    this.count = Math.min(this.count + 1, this.maxN)
    this.frameCount++
    if (this.frameCount % VSYNC_RESAMPLE_FRAMES === 0) this.refreshVsync()
    if (dt > this.vsyncMs * 1.5) {
      this.recentWorst.push([now, dt])
    }
    const inst = Math.min(240, 1000 / Math.max(1, dt))
    this.fpsSmoothed += (inst - this.fpsSmoothed) * 0.12
    if (now - this.lastTextUpdate > 250) {
      this.lastTextUpdate = now
      this.updateText(now)
    }
  }

  /**
   * Refresh interval = median of the on-time frames (those near the 10th percentile). A plain
   * median is dragged up by sustained jank, a plain minimum is one outlier.
   */
  private refreshVsync() {
    if (this.count < 20) return
    const sorted = Array.from(this.dts.subarray(0, this.count)).sort((a, b) => a - b)
    const p10 = sorted[Math.floor(sorted.length * 0.1)]!
    const onTime = sorted.filter(dt => dt <= p10 * 1.4)
    const estimate = onTime.length > 0 ? onTime[Math.floor(onTime.length / 2)]! : p10
    this.vsyncMs = Math.min(50, Math.max(4, estimate))
  }

  private color(dt: number) {
    const drops = dt / this.vsyncMs
    if (drops > 3) return RED
    if (drops > 1.5) return YELLOW
    return GREEN
  }

  private updateText(now: number) {
    while (this.recentWorst.length > 0 && now - this.recentWorst[0]![0] > WORST_WINDOW_MS) this.recentWorst.shift()
    let worst = 0
    for (const [, dt] of this.recentWorst) worst = Math.max(worst, dt)
    const hz = Math.round(1000 / this.vsyncMs)
    const fps = Math.round(this.fpsSmoothed)
    const ratio = fps / hz
    const fpsColor = ratio >= 0.85 ? '#4ade80' : ratio >= 0.5 ? '#facc15' : '#f87171'
    // a narrow strip (phones) has no room for the refresh rate: the colour already scores the FPS against it
    const hzText = this.width < COMPACT_WIDTH_PX ? '' : `/${hz}Hz`
    this.text.innerHTML =
      `<span style="color:${fpsColor};font-size:${Math.round(this.height * 0.6)}px">${fps}</span>${hzText}` +
      (worst > 0 ? ` <span style="color:${this.color(worst)}">${Math.round(worst)}ms</span>` : '')
  }

  private draw() {
    const { ctx, width: w, height: h } = this
    ctx.clearRect(0, 0, w, h)
    const spikeMs = this.vsyncMs * 3
    // Full height = 3 vsyncs, so a column reaching the top is a real spike.
    const scale = h / spikeMs
    const n = this.count
    for (let i = 0; i < n; i++) {
      const idx = (this.head - n + i + this.maxN) % this.maxN
      const dt = this.dts[idx]!
      const x = w - (n - i) * COL_W
      const barH = dt > spikeMs ? h : Math.max(1, dt * scale)
      ctx.fillStyle = this.color(dt)
      ctx.fillRect(x, h - barH, COL_W, barH)
      const cpu = this.cpus[idx]!
      if (cpu > 0) {
        // CPU time of the frame (JS + GL submit) overlaid, tells main-thread work from GPU/vsync waits.
        ctx.fillStyle = CPU
        ctx.fillRect(x, h - Math.min(h, cpu * scale), COL_W, Math.min(h, cpu * scale))
      }
    }
    // One-vsync guide line.
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(0, h - this.vsyncMs * scale, w, 1)
  }
}
