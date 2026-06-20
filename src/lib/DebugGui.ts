// eslint-disable-next-line import/no-named-as-default
import GUI from 'lil-gui'
import { isWebWorker } from '../three/documentRenderer'

export interface ParamMeta {
  min?: number
  max?: number
  step?: number
}

export class DebugGui {
  private gui: GUI | null = null
  private readonly storageKey: string = ''
  private target: any
  private readonly params: string[] = []
  private readonly paramsMeta: Record<string, ParamMeta> = {}
  private _visible = false // Default to not visible
  private readonly initialValues: Record<string, any> = {} // Store initial values
  private initialized = false

  constructor(id: string, target: any, params?: string[], paramsMeta?: Record<string, ParamMeta>) {
    // If in web worker, don't initialize anything
    if (isWebWorker) return

    this.gui = new GUI()
    this.storageKey = `debug_params_${id}`
    this.target = target
    this.paramsMeta = paramsMeta ?? {}
    this.params = params ?? Object.keys(target)

    // Store initial values
    for (const param of this.params) {
      this.initialValues[param] = target[param]
    }

    // Hide by default
    this.gui.domElement.style.display = 'none'
  }

  // Initialize and show the GUI
  activate() {
    if (isWebWorker) return this

    if (!this.initialized && this.gui) {
      this.loadSavedValues()
      this.setupControls()
      this.initialized = true
    }
    this.show()
    return this
  }

  // Getter for visibility
  get visible(): boolean {
    if (isWebWorker) return false
    return this._visible
  }

  // Setter for visibility
  set visible(value: boolean) {
    if (isWebWorker || !this.gui) return
    this._visible = value
    this.gui.domElement.style.display = value ? 'block' : 'none'
    this.saveVisibility()
  }

  private loadSavedValues() {
    if (isWebWorker) return
    try {
      const saved = localStorage.getItem(this.storageKey)
      if (saved) {
        const values = JSON.parse(saved)
        // Apply saved values to target
        for (const param of this.params) {
          if (param in values) {
            const value = values[param]
            if (value !== null) {
              this.target[param] = value
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load debug values:', e)
    }
  }

  private saveValues(deleteKey = false) {
    if (isWebWorker) return
    try {
      const values = {}
      for (const param of this.params) {
        values[param] = this.target[param]
      }
      if (deleteKey) {
        localStorage.removeItem(this.storageKey)
      } else {
        localStorage.setItem(this.storageKey, JSON.stringify(values))
      }
    } catch (e) {
      console.warn('Failed to save debug values:', e)
    }
  }

  private saveVisibility() {
    if (isWebWorker) return
    try {
      localStorage.setItem(`${this.storageKey}_visible`, this._visible.toString())
    } catch (e) {
      console.warn('Failed to save debug visibility:', e)
    }
  }

  private setupControls() {
    if (isWebWorker || !this.gui) return

    // Add visibility toggle at the top
    this.gui.add(this, 'visible').name('Show Controls')
    this.gui
      .add(
        {
          resetAll: () => {
            if (!this.gui) return
            for (const param of this.params) {
              this.target[param] = this.initialValues[param]
            }
            this.saveValues(true)
            this.gui.destroy()
            this.gui = new GUI()
            this.setupControls()
          }
        },
        'resetAll'
      )
      .name('Reset All Parameters')

    for (const param of this.params) {
      const value = this.target[param]
      const meta = this.paramsMeta[param] ?? {}

      if (typeof value === 'number') {
        // For numbers, use meta values or calculate reasonable defaults
        const min = meta.min ?? value - Math.abs(value * 2)
        const max = meta.max ?? value + Math.abs(value * 2)
        const step = meta.step ?? Math.abs(value) / 100

        this.gui.add(this.target, param, min, max, step).onChange(() => this.saveValues())
      } else if (typeof value === 'boolean') {
        // For booleans, create a checkbox
        this.gui.add(this.target, param).onChange(() => this.saveValues())
      } else if (typeof value === 'string' && ['x', 'y', 'z'].includes(param)) {
        // Special case for xyz coordinates
        const min = meta.min ?? -10
        const max = meta.max ?? 10
        const step = meta.step ?? 0.1

        this.gui.add(this.target, param, min, max, step).onChange(() => this.saveValues())
      } else if (Array.isArray(value)) {
        // For arrays, create a dropdown
        this.gui.add(this.target, param, value).onChange(() => this.saveValues())
      }
    }
  }

  // Method to manually trigger save
  save() {
    if (isWebWorker) return
    this.saveValues()
    this.saveVisibility()
  }

  // Method to destroy the GUI and clean up
  destroy() {
    if (isWebWorker || !this.gui) return
    this.saveVisibility()
    this.gui.destroy()
  }

  // Toggle visibility
  toggle() {
    this.visible = !this.visible
  }

  // Show the GUI
  show() {
    this.visible = true
  }

  // Hide the GUI
  hide() {
    this.visible = false
  }
}
