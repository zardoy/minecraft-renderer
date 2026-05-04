#!/usr/bin/env node
/* eslint-disable */
//
// dump-map-chunk.cjs
//
// Dump raw map_chunk (and update_light for 1.17+) packets from a live MC server
// for use as Rust parser fixtures.
//
// Usage:
//   node dump-poc/dump-map-chunk.cjs --host grim.mcraft.fun --version 1.21 --count 3
//
// Required:
//   --version <ver>   Minecraft version, e.g. 1.21, 1.20.4, 1.18.2, 1.17.1, 1.16.5
//
// Optional:
//   --host <host>     server host (default: grim.mcraft.fun)
//   --port <port>     server port (default: 25565)
//   --username <u>    bot username (default: dump_<rand>)
//   --auth <kind>     'offline' (default) | 'microsoft'
//   --count <N>       how many distinct chunks to capture per packet kind (default: 2)
//   --out <dir>       output dir (default: dump-poc/fixtures/map_chunk/<version>/)
//   --timeout <sec>   exit after N seconds even if not all chunks captured (default: 60)
//
// Output per chunk:
//   <out>/<x>_<z>.map_chunk.bin              raw payload bytes (no length prefix, no packet id)
//   <out>/<x>_<z>.map_chunk.meta.json        { version, protocolVersion, x, z, packetName, capturedAt, byteLength }
//   <out>/<x>_<z>.update_light.bin           (1.17+ only) raw update_light payload for the same x,z
//   <out>/<x>_<z>.update_light.meta.json
//
// The .bin files are exactly what `client.emit('raw.<name>', buffer, meta)` provides:
// the deserialized packet body buffer (without varint length prefix and without
// packet-id varint), ready to feed into a versioned Rust parser that expects the
// same byte layout as minecraft-data's protocol.json describes for that packet.
//

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')

function parseArgs () {
  const args = { host: 'grim.mcraft.fun', port: 25565, count: 2, auth: 'offline', timeout: 60 }
  for (let i = 2; i < process.argv.length; i += 2) {
    const k = process.argv[i].replace(/^--/, '')
    const v = process.argv[i + 1]
    if (v === undefined) throw new Error(`missing value for --${k}`)
    args[k] = v
  }
  if (!args.version) {
    console.error('ERROR: --version is required')
    process.exit(1)
  }
  args.port = Number(args.port)
  args.count = Number(args.count)
  args.timeout = Number(args.timeout)
  if (!args.username) args.username = `dump_${Math.random().toString(36).slice(2, 8)}`
  if (!args.out) args.out = path.join(__dirname, 'fixtures', 'map_chunk', args.version)
  return args
}

const args = parseArgs()
fs.mkdirSync(args.out, { recursive: true })

console.log(`[dump-map-chunk] connecting host=${args.host}:${args.port} version=${args.version} username=${args.username}`)

const bot = mineflayer.createBot({
  host: args.host,
  port: args.port,
  version: args.version,
  username: args.username,
  auth: args.auth,
  hideErrors: false,
})

const captured = new Map() // key "x,z" -> { mapChunk?: Buffer, updateLight?: Buffer }
let mapChunkCount = 0
let updateLightCount = 0
let done = false

function allReferencesReady () {
  if (captured.size === 0) return false
  let ok = 0
  for (const [, e] of captured) if (e.mapChunk && e.reference) ok++
  return ok >= args.count
}

function maybeFinish () {
  if (done) return
  if (mapChunkCount >= args.count) {
    // for 1.17 also wait for the same number of update_light, but only if we have observed any
    const lightOk = updateLightCount === 0 || updateLightCount >= mapChunkCount
    if (lightOk && allReferencesReady()) {
      finish('count reached + references ready')
    }
  }
}

function finish (reason) {
  if (done) return
  done = true
  console.log(`[dump-map-chunk] finishing: ${reason}`)
  const summary = []
  for (const [key, data] of captured) {
    const [x, z] = key.split(',').map(Number)
    if (!data.mapChunk) continue
    const baseName = `${x}_${z}`
    const meta = {
      version: args.version,
      protocolVersion: bot.protocolVersion ?? null,
      x, z,
      packetName: 'map_chunk',
      capturedAt: new Date().toISOString(),
      byteLength: data.mapChunk.length,
    }
    fs.writeFileSync(path.join(args.out, `${baseName}.map_chunk.bin`), data.mapChunk)
    fs.writeFileSync(path.join(args.out, `${baseName}.map_chunk.meta.json`), JSON.stringify(meta, null, 2))
    summary.push({ x, z, mapChunk: data.mapChunk.length })

    if (data.updateLight) {
      const lmeta = {
        version: args.version,
        protocolVersion: bot.protocolVersion ?? null,
        x, z,
        packetName: 'update_light',
        capturedAt: new Date().toISOString(),
        byteLength: data.updateLight.length,
      }
      fs.writeFileSync(path.join(args.out, `${baseName}.update_light.bin`), data.updateLight)
      fs.writeFileSync(path.join(args.out, `${baseName}.update_light.meta.json`), JSON.stringify(lmeta, null, 2))
      summary[summary.length - 1].updateLight = data.updateLight.length
    }

    if (data.reference) {
      fs.writeFileSync(path.join(args.out, `${baseName}.reference.json`), JSON.stringify(data.reference))
      summary[summary.length - 1].reference = true
    }
  }
  const summaryFile = path.join(args.out, '_summary.json')
  fs.writeFileSync(summaryFile, JSON.stringify({
    version: args.version,
    protocolVersion: bot.protocolVersion ?? null,
    host: args.host,
    capturedAt: new Date().toISOString(),
    chunks: summary,
  }, null, 2))
  console.log(`[dump-map-chunk] wrote ${summary.length} chunk(s) to ${args.out}`)
  console.log(`[dump-map-chunk] summary: ${summaryFile}`)
  try { bot.quit() } catch {}
  setTimeout(() => process.exit(0), 200)
}

setTimeout(() => finish(`timeout ${args.timeout}s`), args.timeout * 1000)

bot.once('login', () => {
  console.log(`[dump-map-chunk] logged in. protocolVersion=${bot.protocolVersion}`)

  const client = bot._client

  // raw.* gives us the packet body buffer (including the packet id varint at the start
  // for some minecraft-protocol versions). For 1.18+ the packet name is "map_chunk".
  //
  // IMPORTANT: in 1.20.2+ chunks arrive in batches. raw and parsed events do not have a
  // 1:1 ordering guarantee — observed: parsed fires BEFORE raw in current minecraft-
  // protocol for 1.21. Pairing by "last seen raw" (a single global) silently swaps
  // buffers between parsed events. Pair by (x, z) extracted from the raw buffer instead.
  //
  // Buffer layout: [packet_id varint][x: i32 BE][z: i32 BE][...]
  function readVarIntFromBuffer (buf, offset) {
    let value = 0, shift = 0, pos = offset
    while (pos < buf.length) {
      const b = buf.readUInt8(pos++)
      value |= (b & 0x7F) << shift
      if ((b & 0x80) === 0) return { value, bytesRead: pos - offset }
      shift += 7
      if (shift > 35) return null
    }
    return null
  }
  const rawBufferByXZ = new Map()
  client.on('raw.map_chunk', (buffer, _meta) => {
    const buf = Buffer.from(buffer)
    const pid = readVarIntFromBuffer(buf, 0)
    if (!pid || buf.length < pid.bytesRead + 8) return
    const x = buf.readInt32BE(pid.bytesRead)
    const z = buf.readInt32BE(pid.bytesRead + 4)
    const key = `${x},${z}`
    rawBufferByXZ.set(key, buf)
    // raw arrived after parsed for this chunk — flush now.
    const pendingEntry = pendingParsedByXZ.get(key)
    if (pendingEntry) {
      pendingParsedByXZ.delete(key)
      handleMapChunk(pendingEntry, x, z, buf)
    }
  })
  const pendingParsedByXZ = new Map()

  function snapshotReference (entry, cx, cz) {
    if (!entry || entry.reference) return false
    try {
      const column = bot.world.getColumn(cx, cz)
      if (!column) return false
      const minY = column.minY ?? 0
      const numSections = column.numSections ?? (column.worldHeight ? column.worldHeight / 16 : 16)
      const total = numSections * 4096
      const blocks = new Uint16Array(total)
      const biomes = new Uint8Array(total)
      const sky = new Uint8Array(total)
      const blk = new Uint8Array(total)
      for (let yAbs = 0; yAbs < numSections * 16; yAbs++) {
        const y = yAbs + minY
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const idx = x + z * 16 + yAbs * 256
            const p = { x, y, z }
            blocks[idx] = column.getBlockStateId(p) | 0
            biomes[idx] = column.getBiome(p) & 0xff
            sky[idx] = column.getSkyLight(p) & 0xff
            blk[idx] = column.getBlockLight(p) & 0xff
          }
        }
      }
      entry.reference = {
        numSections, minY,
        block_states_b64: Buffer.from(blocks.buffer).toString('base64'),
        biomes_b64: Buffer.from(biomes).toString('base64'),
        sky_light_b64: Buffer.from(sky).toString('base64'),
        block_light_b64: Buffer.from(blk).toString('base64'),
      }
      console.log(`[dump-map-chunk] snapshot reference x=${cx} z=${cz} sections=${numSections} minY=${minY}`)
      return true
    } catch (e) {
      console.warn(`[dump-map-chunk] reference snapshot failed for ${cx},${cz}: ${e?.message ?? e}`)
      return false
    }
  }

  function handleMapChunk (entry, x, z, rawBuf) {
    const key = `${x},${z}`
    if (captured.has(key) && captured.get(key).mapChunk) return
    if (mapChunkCount >= args.count && !captured.has(key)) return
    entry.mapChunk = rawBuf
    captured.set(key, entry)
    rawBufferByXZ.delete(key)
    mapChunkCount++
    console.log(`[dump-map-chunk] captured map_chunk x=${x} z=${z} bytes=${entry.mapChunk.length} (${mapChunkCount}/${args.count})`)
    snapshotReference(entry, x, z)
    maybeFinish()
  }

  client.on('map_chunk', (packet) => {
    const key = `${packet.x},${packet.z}`
    const rawBuf = rawBufferByXZ.get(key)
    if (rawBuf) {
      const entry = captured.get(key) ?? {}
      handleMapChunk(entry, packet.x, packet.z, rawBuf)
    } else {
      // raw hasn't arrived yet — defer.
      const entry = captured.get(key) ?? {}
      pendingParsedByXZ.set(key, entry)
    }
  })

  // Fallback for versions/cases where the column isn't ready in the map_chunk
  // handler (mostly 1.17 where light arrives separately).
  bot.on('chunkColumnLoad', (pos) => {
    const cx = Math.floor(pos.x / 16)
    const cz = Math.floor(pos.z / 16)
    const entry = captured.get(`${cx},${cz}`)
    if (!entry || !entry.mapChunk || entry.reference) return
    if (snapshotReference(entry, cx, cz)) maybeFinish()
  })

  let pendingUpdateLightBuffer = null
  client.on('raw.update_light', (buffer) => {
    pendingUpdateLightBuffer = Buffer.from(buffer)
  })
  client.on('update_light', (packet) => {
    if (!pendingUpdateLightBuffer) return
    const x = packet.chunkX ?? packet.x
    const z = packet.chunkZ ?? packet.z
    const key = `${x},${z}`
    const entry = captured.get(key) ?? {}
    if (entry.updateLight) { pendingUpdateLightBuffer = null; return }
    entry.updateLight = pendingUpdateLightBuffer
    captured.set(key, entry)
    pendingUpdateLightBuffer = null
    updateLightCount++
    console.log(`[dump-map-chunk] captured update_light x=${x} z=${z} bytes=${entry.updateLight.length} (${updateLightCount})`)
    maybeFinish()
  })
})

bot.on('kicked', (reason) => {
  console.error(`[dump-map-chunk] kicked: ${reason}`)
  finish('kicked')
})

bot.on('error', (err) => {
  console.error(`[dump-map-chunk] error: ${err?.message ?? err}`)
})

bot.on('end', (reason) => {
  console.log(`[dump-map-chunk] end: ${reason}`)
  finish('end')
})
