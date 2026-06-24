import { blockBreakParticlesManifest } from './blockBreakParticles'
import { cameraBobbingManifest } from './cameraBobbing'
import { rainManifest } from './rain'
import { sciFiWorldRevealManifest } from './sciFiWorldReveal'
import { starfieldManifest } from './starfield'

export const BUILTIN_MODULES = {
  starfield: starfieldManifest,
  futuristicReveal: sciFiWorldRevealManifest,
  rain: rainManifest,
  cameraBobbing: cameraBobbingManifest,
  blockBreakParticles: blockBreakParticlesManifest
}
