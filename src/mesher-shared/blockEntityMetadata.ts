import { Vec3 } from 'vec3'

export interface SignMeta { isWall: boolean; isHanging: boolean; rotation: number }
export interface HeadMeta { isWall: boolean; rotation: number }
export interface BannerMeta {
  isWall: boolean
  blockName: string
  rotation: number
  blockLightNorm: number
  skyLightNorm: number
}

export interface BlockEntityMetadataTarget {
  signs: Record<string, SignMeta>
  heads: Record<string, HeadMeta>
  banners: Record<string, BannerMeta>
}

export interface BlockEntityMetadataOptions {
  disableBlockEntityTextures?: boolean
}

type BlockLike = { name: string; getProperties(): any }

type LightSampler = {
  getChannelLightNorm(pos: Vec3): { block: number, sky: number }
}

export function collectBlockEntityMetadata(
  block: BlockLike,
  x: number, y: number, z: number,
  target: BlockEntityMetadataTarget,
  options: BlockEntityMetadataOptions,
  world?: LightSampler,
): void {
  if ((block.name.includes('_sign') || block.name === 'sign') && !options.disableBlockEntityTextures) {
    const key = `${x},${y},${z}`
    const props: any = block.getProperties()
    const facingRotationMap = {
      'north': 2,
      'south': 0,
      'west': 1,
      'east': 3
    }
    const isWall = block.name.endsWith('wall_sign') || block.name.endsWith('wall_hanging_sign')
    const isHanging = block.name.endsWith('hanging_sign')
    target.signs[key] = {
      isWall,
      isHanging,
      rotation: isWall ? facingRotationMap[props.facing] : +props.rotation
    }
  } else if (block.name === 'player_head' || block.name === 'player_wall_head') {
    const key = `${x},${y},${z}`
    const props: any = block.getProperties()
    const facingRotationMap = {
      'north': 0,
      'south': 2,
      'west': 3,
      'east': 1
    }
    const isWall = block.name === 'player_wall_head'
    target.heads[key] = {
      isWall,
      rotation: isWall ? facingRotationMap[props.facing] : +props.rotation
    }
  } else if (block.name.includes('_banner') && !options.disableBlockEntityTextures) {
    const key = `${x},${y},${z}`
    const props: any = block.getProperties()
    const facingRotationMap = {
      'north': 2,
      'south': 0,
      'west': 1,
      'east': 3
    }
    const isWall = block.name.endsWith('_wall_banner')
    const light = world?.getChannelLightNorm(new Vec3(x, y, z)) ?? { block: 0, sky: 1 }
    target.banners[key] = {
      isWall,
      blockName: block.name, // Pass block name for base color extraction
      rotation: isWall ? facingRotationMap[props.facing] : (props.rotation === undefined ? 0 : +props.rotation),
      blockLightNorm: light.block,
      skyLightNorm: light.sky,
    }
  }
}
