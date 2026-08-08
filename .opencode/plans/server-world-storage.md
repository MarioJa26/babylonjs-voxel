# Server-Side World Storage (Like Singleplayer)

## Goal
Save full chunk data (blocks + light) using the same region file format as singleplayer. Currently the server only stores a flat JSON log of block edits — terrain doesn't persist across restarts and seed changes don't wipe old data.

## User Decisions
- **Storage scope:** Save ALL chunks (not just modified ones) — faster loads, no regen needed
- **Seed change behavior:** Manual only — admin must delete `server-data/worlds/<name>/` to reset (no auto-wipe)

## Architecture

### Storage Layout (mirrors singleplayer)
```
server-data/
  worlds/
    <worldName>/
      seed.txt           ← plaintext seed hash (for admin reference)
      regions/
        r.X.Y.Z.bin      ← same binary format as singleplayer
```

### Data Flow

**Block edit:**
```
Client breaks/places block
  → server receives BlockEdit
  → applies to in-memory chunk
  → marks chunk as modified
  → after debounce: serialize chunk → write to region file
```

**Chunk request:**
```
Client requests chunk (cx,cy,cz)
  → check in-memory cache
  → if miss: read from region file → deserialize → send to client
  → if region file miss: generate with WorldGenerator → serialize → save to region file → send
```

**Server restart:**
```
Server starts → no in-memory state
  → client connects → requests chunks → read from region files (fast, no regen)
```

## Files to Create/Modify

### 1. `server/src/world/RegionFile.ts` (NEW)
Port of `src/code/World/Storage/RegionFile.ts` using Node.js `fs` instead of OPFS.

Key changes from singleplayer version:
- Replace `FileSystemFileHandle`/`FileSystemSyncAccessHandle` with `fs.openSync`/`fs.readSync`/`fs.writeSync`
- Same binary format: 4096-byte header + 65536-byte slot table + data section
- Same serialization via `VoxelSerializer` (imported from shared code)
- Same gzip compression via `zlib.gzipSync`/`zlib.gunzipSync`
- Same compaction logic (reclaim orphaned space)
- `MAX_OPEN_REGIONS = 128` LRU cache

Reuses from shared code (`src/code/World/Storage/`):
- `VoxelSerializer` — `serializeVoxelData()` / `deserializeVoxelData()`
- `compressBlocks()` / `decompressBlocks()` — gzip helpers
- Region dimension constants (`REGION_DIM = 16`)

### 2. `server/src/world/ServerWorldStorage.ts` (REWRITE)
Replace the flat JSON edit-log with region file storage.

**Current:** `getEdits()` / `addEdit()` → flat JSON array of `{x,y,z,blockId,action,timestamp}`

**New:**
- `readChunk(cx,cy,cz)` → returns `{blocks, light, palette, isUniform, uniformBlockId, hash}` or null
- `writeChunk(cx,cy,cz, data)` → serialize + write to region file
- `flush()` → flush all dirty region files
- Region file LRU cache

### 3. `server/src/rooms/VoxelRoom.ts` (MODIFY)
**On block edit:**
- Apply to in-memory chunk (existing)
- Schedule chunk save (debounced 500ms like singleplayer)
- On save: serialize full chunk → `worldStorage.writeChunk()`

**On chunk request:**
- Check `worldStorage.readChunk(cx,cy,cz)` first
- If hit: send stored data to client
- If miss: generate → `worldStorage.writeChunk()` → send

### 4. `server/src/world/ChunkGenerationService.ts` (MODIFY)
- On `generateChunk()`: after generation, call `worldStorage.writeChunk()` before returning
- On `generateChunksBatch()`: same for each chunk

### 5. `server/server.properties` (MODIFY)
Add:
```properties
# Where world data is stored
world-storage-path=server-data
```

### 6. `server/src/config/ServerConfig.ts` (MODIFY)
Add `worldStoragePath: boolean` field.

## Implementation Detail: Region File Port

The singleplayer `RegionFile` class needs these OPFS calls replaced:

| OPFS API | Node.js Equivalent |
|----------|-------------------|
| `fileHandle.createSyncAccessHandle()` | `fs.openSync(path, 'r+')` (create if not exists) |
| `accessHandle.read(buffer, {at})` | `fs.readSync(fd, buffer, 0, length, position)` |
| `accessHandle.write(buffer, {at})` | `fs.writeSync(fd, buffer, 0, length, position)` |
| `accessHandle.flush()` | `fs.fsyncSync(fd)` |
| `accessHandle.getSize()` | `fs.fstatSync(fd).size` |
| `accessHandle.truncate(size)` | `ftruncateSync(fd, size)` |

Everything else stays identical — slot table math, compaction, dirty tracking, the binary format.

## Serialization (reused from shared code)

The `VoxelSerializer` produces this blob:
```
[flags: 1 byte]
[version: 1 byte]
[if IS_UNIFORM:]       uniformBlockId: u16 LE
[if HAS_BLOCKS:]       byteLength: u32 LE, then gzip(block data)
[if HAS_PALETTE:]      count: u32 LE, then count*2 bytes palette
[if HAS_LIGHT:]        byteLength: u32 LE, then gzip(light data)
```

Three block storage modes:
1. **Uniform** — 1 block ID for entire chunk (2 bytes)
2. **Palette** — nibble-packed + palette (≤16 unique blocks)
3. **Dense** — u16 per block (>16 unique blocks)

## Chunk Save Trigger

Singleplayer uses a 500ms debounce on the main thread. Server equivalent:
- On block edit: mark chunk dirty + schedule save
- Save pump runs every frame (or on interval): iterate dirty chunks → serialize → write to region
- On room dispose: flush all pending saves

## Performance Considerations

- **Region files cover 16×16×16 = 4096 chunks each** — fewer files, better for filesystem
- **Gzip compression** — uniform chunks compress to ~50 bytes, typical chunks ~2-5 KB
- **All chunks stored** — a fully-explored render distance of 3 = ~2500 chunks = ~5-10 MB per player's explored area
- **LRU region cache** — max 128 open files, evict least recently used
- **Async I/O** — use `fs.promises` or worker threads to avoid blocking the room tick

## Migration

Existing `server-data/worlds/*.json` files become obsolete but harmless. The new system ignores them. Admin can delete them manually or we add a one-time migration that converts JSON edits → region files (probably not worth it for now).
