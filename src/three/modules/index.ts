import { blockBreakParticlesManifest } from './blockBreakParticles'
import { cameraBobbingManifest } from './cameraBobbing'
import { cloudsManifest } from './clouds'
import { rainManifest } from './rain'
import { sciFiWorldRevealManifest } from './sciFiWorldReveal'
import { starfieldManifest } from './starfield'
import { sunMoonManifest } from './sunMoon'

export const BUILTIN_MODULES = {
  starfield: starfieldManifest,
  sunMoon: sunMoonManifest,
  clouds: cloudsManifest,
  futuristicReveal: sciFiWorldRevealManifest,
  rain: rainManifest,
  cameraBobbing: cameraBobbingManifest,
  blockBreakParticles: blockBreakParticlesManifest
}
