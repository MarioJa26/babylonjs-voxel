
# b102

`b102` is a browser-based voxel world engine and sandbox prototype written in TypeScript using Babylon.js.
The project is served and developed using Vite.
It focuses on procedural world generation, chunk-based streaming, voxel rendering, and player interaction systems.

<img width="1851" height="834" alt="Game" src="https://github.com/user-attachments/assets/9935f7ac-24be-47f5-b4f7-ca9d2aa39ecd" />

## Overview

This repository contains a custom voxel engine with:

- Chunk-based terrain generation and streaming
- Multi-threaded mesh and terrain generation using Web Workers
- Deterministic, seed-based procedural generation
- Player movement, inventory, HUD, and interaction systems
- Vehicles with basic physics and buoyancy
- Persistent world storage in the browser

The codebase is modular and intended for experimentation rather than production use.

## Core Systems

### World and Terrain

- Procedural terrain generation with biomes, rivers, caves, and surface rules
- Structures such as towers, dungeons, and lava pools
- Heightmaps and spline-based terrain shaping
- Deterministic generation driven by numeric seeds

### Voxel Engine

- Chunk-based voxel world representation
- Greedy meshing with multiple LOD levels
- Custom block shapes and partial blocks
- Sky light and block light propagation
- Water-aware meshing and rendering

### Rendering

- Babylon.js rendering pipeline
- Separate shader paths for near and distant terrain
- LOD transitions with cached meshes
- Optional SSAO, fog, sky, and underwater effects

### Player and Interaction

- First/third-person camera with mouse look
- Walking, swimming, flying, and sprinting
- Inventory and crafting UI
- Block interaction and placement
- Debug and pause menus

### Vehicles

- Boats and water vehicles with buoyancy physics
- Mounting and dismounting system
- Voxel-based boat construction support

### Performance and Architecture

- Web Worker pool for terrain generation, meshing, and LOD work
- Incremental chunk loading and unloading
- Background persistence of modified chunks
- IndexedDB-based world storage

## Project Size

The project currently consists of approximately:

- 100 classes
- 27,000 lines of TypeScript
- Multiple worker pipelines and rendering paths

A generated breakdown of the codebase is available in footprint.md.

## Development

Uses Vite for serving and builds.

Requirements:

- Node.js (18+ recommended)
- npm

Common development commands:

    npm install
    npm run serve
    npm run build
    npm run lint

## Project Structure (Simplified)

    src/
    ├── Generation/     Terrain, biomes, noise, structures
    ├── World/          Chunks, meshing, lighting, storage
    ├── Player/         Player logic, controls, HUD
    ├── Entities/       Boats, mounts, usable entities
    ├── Maps/           Scenes and environments
    ├── Server/         Networking stubs / experiments
    └── TestScene.ts    Entry scene

## Persistence

- Player state (position and inventory) is saved automatically
- Modified chunks are persisted incrementally
- LOD mesh caches are versioned and invalidated when necessary

## Status

This is an experimental project.
APIs and internal structures may change without notice.

## License

License not yet specified.
