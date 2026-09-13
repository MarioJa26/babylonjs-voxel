# WASM Noise Acceleration for Server Chunk Generation

## Goal
Make the server's chunk workers use the same WASM SIMD noise backend as the client, for identical terrain at ~4-8x higher throughput.

## Why This Works
`createWasmNoiseBackend()` in `src/code/Lib/WasmKernels.ts:432` only needs raw `.wasm` bytes — it uses `WebAssembly.Module`/`Instance`, which are Node.js globals. The WASM module's only import is `env.abort`, already provided. No browser APIs needed.

## Files to Modify

### 1. `src/code/Lib/WasmNoise.ts`
Add `loadWasmNoiseFromFile(filePath)` for Node.js:
- Uses `fs.readFileSync` + `path.resolve` to load bytes from `src/code/wasm/kernels.wasm` (relative to `process.cwd()`)
- Calls `setNoiseBackend(createWasmNoiseBackend(bytes))`
- Returns `boolean` (true = WASM active, false = fell back to JS)
- Never throws — any failure falls back to JS backend
- `filePath` defaults to `src/code/wasm/kernels.wasm`

Also add `KERNELS_WASM_PATH = "src/code/wasm/kernels.wasm"` constant.

### 2. `server/server.properties`
Add:
```properties
# Enable WASM SIMD noise acceleration for chunk generation (true/false)
wasm-enabled=true
```

### 3. `server/src/config/ServerConfig.ts`
- Add `wasmEnabled: boolean` field to `ServerConfig` interface
- Add `wasmEnabled: DEFAULTS.wasmEnabled` to defaults
- Parse `wasm-enabled` key in `loadServerConfig()` using existing `parseBoolean()`

### 4. `server/src/workers/ChunkWorkerPool.ts`
- Extend `initialize(seed)` → `initialize(seed, wasmEnabled = true)`
- Pass `wasmEnabled` flag in the postMessage to workers
- Store `this.wasmEnabled` for use when recreating workers

### 5. `server/src/workers/chunkWorker.ts`
- Import `loadWasmNoiseFromFile` from `@/code/Lib/WasmNoise`
- In `ensureInit(seed)`: if `wasmEnabled`, call `await loadWasmNoiseFromFile()` before constructing `WorldGenerator`
- Log which backend is active
- Handle the `wasmEnabled` flag from the init message

### 6. `server/src/rooms/VoxelRoom.ts`
- Pass `this.config.wasmEnabled` to `this.chunkGen.initialize(seed, wasmEnabled)`

## Flow
```
server start
  → loadServerConfig() reads wasm-enabled=true
  → VoxelRoom.onCreate: chunkGen.initialize(seed, config.wasmEnabled)
    → ChunkWorkerPool.initialize(seed, wasmEnabled)
      → postMessage({ seed, wasmEnabled }) to each worker
        → chunkWorker.ensureInit(seed, wasmEnabled)
          → if wasmEnabled: loadWasmNoiseFromFile()
            → setNoiseBackend(createWasmNoiseBackend(bytes))
          → new WorldGenerator(params) — uses WASM backend
```

## Design Decisions
- **Single WASM file**: Both client and server use `src/code/wasm/kernels.wasm`
- **Graceful fallback**: Missing file or `wasm-enabled=false` → JS backend
- **Configurable**: Toggle in `server.properties`
- **No new dependencies**: `fs`/`path` are Node.js builtins
- **Lazy load**: WASM compiled once per worker thread, before generation starts
