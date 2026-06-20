/** Settings / labels only — no Three.js or DocumentRenderer (safe for defaultOptions imports). */

export const V2_SCENE_IDS = ['galaxy', 'nether', 'end', 'cyber', 'light'] as const
export type V2SceneId = (typeof V2_SCENE_IDS)[number]

export const V2_CAMERA_IDS = ['cruise', 'barrel', 'dive', 'orbit', 'snake'] as const
export type V2CameraId = (typeof V2_CAMERA_IDS)[number]

export const V2_SCENE_LABELS: Record<V2SceneId, string> = {
  galaxy: 'Galaxy',
  nether: 'Nether',
  end: 'The End',
  cyber: 'Cyber',
  light: 'Light Space'
}

export const V2_CAMERA_LABELS: Record<V2CameraId, string> = {
  cruise: 'Cruise',
  barrel: 'Barrel',
  dive: 'Dive',
  orbit: 'Orbit',
  snake: 'Snake'
}

export const MINECRAFT_BLOCK_GROUP_IDS = ['mixed', 'stainedGlass', 'wool', 'construction', 'glow', 'world'] as const
export type MinecraftBlockGroupId = (typeof MINECRAFT_BLOCK_GROUP_IDS)[number]

export const MINECRAFT_BLOCK_GROUP_LABELS: Record<MinecraftBlockGroupId, string> = {
  mixed: 'Mixed',
  stainedGlass: 'Stained glass',
  wool: 'Wool',
  construction: 'Construction',
  glow: 'Glow',
  world: 'World (grass & ores)'
}
