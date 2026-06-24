import { WorldRendererThree } from './worldRendererThree'

/**
 * Instance interface for module controllers
 */
export interface RendererModuleController {
  enable(): void
  disable(): void
  dispose(): void

  enablementCheck?: () => boolean
  autoEnableCheck?: () => boolean // Called when config updates, returns true to enable, false to disable
  render?: (deltaTime: number) => void
}

/**
 * Constructor type for module controllers
 */
export type RendererModuleControllerConstructor = new (worldRenderer: WorldRendererThree) => RendererModuleController

export interface RendererModuleManifest {
  id: string

  controller: RendererModuleControllerConstructor

  enabledDefault?: boolean
  cannotBeDisabled?: boolean
  slowSystemAutoDisable?: boolean
  userSettingsSchema?: Record<string, any>

  requiresHeightmap?: boolean
}

export interface RegisteredModule {
  manifest: RendererModuleManifest
  controller: RendererModuleController
  enabled: boolean
  toggle: () => boolean
}
