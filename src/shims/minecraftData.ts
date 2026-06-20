/**
 * Minecraft Data Shim
 *
 * Provides a minimal minecraft-data implementation that only loads
 * the versions specified in globalThis.includedVersions.
 */

const VERSION = '1.16.5'

// Lazy-loaded data for each data type
const createLazyData = (version: string) => ({
  get attributes() {
    return require('minecraft-data/minecraft-data/data/pc/1.16/attributes.json')
  },
  get blocks() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/blocks.json')
  },
  get blockCollisionShapes() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.1/blockCollisionShapes.json')
  },
  get biomes() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/biomes.json')
  },
  get effects() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.1/effects.json')
  },
  get items() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/items.json')
  },
  get enchantments() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.4/enchantments.json')
  },
  get recipes() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/recipes.json')
  },
  get instruments() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.1/instruments.json')
  },
  get materials() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/materials.json')
  },
  get language() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.1/language.json')
  },
  get entities() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/entities.json')
  },
  get protocol() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/protocol.json')
  },
  get windows() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.1/windows.json')
  },
  get version() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.5/version.json')
  },
  get foods() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.1/foods.json')
  },
  get particles() {
    return require('minecraft-data/minecraft-data/data/pc/1.16/particles.json')
  },
  get blockLoot() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/blockLoot.json')
  },
  get entityLoot() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/entityLoot.json')
  },
  get loginPacket() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/loginPacket.json')
  },
  get tints() {
    return require('minecraft-data/minecraft-data/data/pc/1.16.2/tints.json')
  },
  get mapIcons() {
    return require('minecraft-data/minecraft-data/data/pc/1.16/mapIcons.json')
  },
  get sounds() {
    return require('minecraft-data/minecraft-data/data/pc/1.16/sounds.json')
  }
})

module.exports = {
  pc: {
    [VERSION]: createLazyData(VERSION)
  }
}
