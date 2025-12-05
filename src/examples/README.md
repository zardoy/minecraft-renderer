# Examples

This directory contains examples showing how to use the `@minecraft-renderer` library.

## AppViewerExample

**File**: `appViewerExample.ts`

A comprehensive example showing how to:
- Initialize the AppViewer
- Load a graphics backend
- Set up a world with blocks
- Handle player state
- Switch between panorama and world modes

### Usage

```typescript
import { AppViewerExample, runExample } from 'minecraft-renderer'

// Run the complete example
await runExample()

// Or use the class directly
const example = new AppViewerExample()
await example.init()
await example.startWorld()
```

## Initial Menu Start

**File**: `initialMenuStart.ts`

A recreation of the original app viewer functionality, showing how to:
- Create a global app viewer instance
- Handle demo mode vs panorama mode
- Load Minecraft data
- Set up a simple world with water blocks
- Position the camera

This example closely mirrors your original implementation and can be used as a reference for migrating existing code.

### Usage

```typescript
import { appViewer, initialize, initialMenuStart } from 'minecraft-renderer'

// Initialize everything
await initialize()

// Or just start the menu
await initialMenuStart()

// Access the global app viewer
appViewer.startPanorama()
```

## Building the Library

To build the library for distribution:

```bash
# Build TypeScript declarations
npm run build

# Build the bundled library
npm run build:lib

# Build minified version
npm run build:lib:minify

# Watch mode for development
npm run watch:lib

# Build everything
npm run build:all
```

## Integration Guide

### 1. Basic Setup

```typescript
import { AppViewer, createGraphicsBackend } from 'minecraft-renderer'

const viewer = new AppViewer({
  config: {
    fpsLimit: 60,
    powerPreference: 'high-performance'
  }
})

// Set up resource manager
viewer.resourcesManager = new ResourcesManager()

// Load backend
await viewer.loadBackend(createGraphicsBackend)
```

### 2. Starting a World

```typescript
// Create your world provider
const world = {
  getColumnAt: (pos) => ({ /* chunk data */ }),
  setBlockStateId: (pos, stateId) => { /* set block */ }
}

// Start the world
await viewer.startWorld(world, renderDistance)

// Initialize world view
await viewer.worldView?.init(startPosition)
```

### 3. Camera Control

```typescript
viewer.updateCamera(
  new Vec3(x, y, z), // position
  yaw,               // rotation Y
  pitch              // rotation X
)
```

### 4. Player State

```typescript
// Update player state
Object.assign(viewer.playerState.reactive, {
  username: 'Player',
  gameMode: 'creative'
})
```

## Migration from Original Code

If you're migrating from the original implementation:

1. **Replace imports**: Update import paths to use the new module structure
2. **Use AppViewer**: Replace direct backend usage with AppViewer
3. **Update WorldView**: Use the new WorldView class instead of WorldDataEmitter
4. **Resource Manager**: Set up ResourcesManager on the AppViewer instance
5. **Player State**: Use the new player state structure

See `initialMenuStart.ts` for a direct migration example.


