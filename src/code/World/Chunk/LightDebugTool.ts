// ---------------------------------------------------------------------------
// LightDebugTool
//
// Temporary in-game diagnostic for sky-light propagation under terrain
// overhangs.  Press F8 while in-game to dump, for the chunk under the player
// and its six neighbors, registration / refinement state plus vertical
// sky-light profiles for the 3x3 columns around the player.
// ---------------------------------------------------------------------------

import {
	getBlockLight,
	getSkyLight,
	worldToBlockCoord,
	worldToChunkCoord,
} from "@/code/Lib/VoxelMath";
import { Chunk, getChunk } from "./Chunk";
import { ChunkWorkerPool } from "./ChunkWorkerPool";
import {
	LIGHT_HEADER_FLAG_LOADED,
	readHeaderFlags,
} from "./Worker/ChunkLightHeader";

type Vec3Like = { x: number; y: number; z: number };

const DIRS: Array<[number, number, number]> = [
	[0, 0, 0],
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
];

export function installLightDebugTool(
	getPlayerPos: () => Vec3Like | undefined,
): () => void {
	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== "F8") return;
		const pos = getPlayerPos();
		if (!pos) {
			console.log("[light-debug] no player position");
			return;
		}
		dumpLightDiagnostics(pos.x, pos.y, pos.z);
	};
	window.addEventListener("keydown", onKeyDown);
	return () => window.removeEventListener("keydown", onKeyDown);
}

function dumpLightDiagnostics(wx: number, wy: number, wz: number): void {
	const px = Math.floor(wx);
	const py = Math.floor(wy);
	const pz = Math.floor(wz);
	const pcx = worldToChunkCoord(px);
	const pcy = worldToChunkCoord(py);
	const pcz = worldToChunkCoord(pz);

	console.log(
		`%c[light-debug] player world(${px}, ${py}, ${pz}) chunk(${pcx}, ${pcy}, ${pcz})`,
		"color:#7fd7ff;font-weight:bold",
	);

	dumpChunkTable(pcx, pcy, pcz);
	dumpColumns(px, py, pz);
}

function dumpChunkTable(pcx: number, pcy: number, pcz: number): void {
	const pool = ChunkWorkerPool.getInstance();
	const lines: string[] = ["-- chunk state (self + neighbors) --"];
	for (const [dx, dy, dz] of DIRS) {
		const c = getChunk(pcx + dx, pcy + dy, pcz + dz);
		if (!c) {
			lines.push(
				`  (${dx > 0 ? "+" : ""}${dx},${dy > 0 ? "+" : ""}${dy},${dz > 0 ? "+" : ""}${dz}) chunk(${pcx + dx}, ${pcy + dy}, ${pcz + dz}) NOT LOADED`,
			);
			continue;
		}
		const headerView = Chunk.lightHeaderView;
		const flags =
			c.lightHeaderSlot >= 0 && headerView
				? readHeaderFlags(headerView, c.lightHeaderSlot)
				: 0;
		const workerRegistered = (flags & LIGHT_HEADER_FLAG_LOADED) !== 0;
		const seedLen = pool.debugLightSeedLength(c.id);
		const mesh =
			(c.mesh ? "mesh" : "") +
			(c.transparentMesh ? "+tmesh" : "") +
			(c.opaqueMeshData || c.transparentMeshData ? "+data" : "");
		lines.push(
			`  (${dx > 0 ? "+" : ""}${dx},${dy > 0 ? "+" : ""}${dy},${dz > 0 ? "+" : ""}${dz}) ` +
				`chunk(${c.chunkX}, ${c.chunkY}, ${c.chunkZ}) id=${c.id} ` +
				`loaded=${c.isLoaded} voxel=${c.hasVoxelData} terrainSched=${c.isTerrainScheduled} ` +
				`slot=${c.lightHeaderSlot} workerReg=${workerRegistered} ` +
				`seedLen=${seedLen === undefined ? "n/a" : seedLen} ` +
				`${mesh ? mesh : "noMesh"}`,
		);
	}
	console.log(lines.join("\n"));
}

function dumpColumns(px: number, py: number, pz: number): void {
	console.log("-- sky-light columns (3x3 around player; runs collapsed) --");
	for (let dz = -1; dz <= 1; dz++) {
		for (let dx = -1; dx <= 1; dx++) {
			const worldX = px + dx;
			const worldZ = pz + dz;
			console.log(
				`\ncolumn dx=${dx > 0 ? "+" : ""}${dx} dz=${dz > 0 ? "+" : ""}${dz}  worldX=${worldX} worldZ=${worldZ}`,
			);
			dumpColumn(worldX, worldZ, py);
		}
	}
}

function dumpColumn(worldX: number, worldZ: number, py: number): void {
	const cx = worldToChunkCoord(worldX);
	const cz = worldToChunkCoord(worldZ);
	const lx = worldToBlockCoord(worldX);
	const lz = worldToBlockCoord(worldZ);

	const lines: string[] = [];
	let runStart = -1;
	let runBlock = -2;
	let runSky = -2;
	let runBlockLight = -2;
	let runLoaded = false;

	const flushRun = (runEnd: number): void => {
		if (runStart === -1) return;
		const rng = runStart === runEnd ? `${runStart}` : `${runEnd}..${runStart}`;
		if (!runLoaded) {
			lines.push(`  y=${rng} -- not loaded --`);
		} else {
			const marker = runStart <= py && py <= runEnd ? "  <-- player" : "";
			lines.push(
				`  y=${rng}  air=${runBlock === 0} block=${runBlock} sky=${runSky} blockLight=${runBlockLight}${marker}`,
			);
		}
		runStart = -1;
	};

	for (let y = py + 40; y >= py - 40; y--) {
		const cy = worldToChunkCoord(y);
		const chunk = getChunk(cx, cy, cz);
		if (!chunk?.isLoaded || !chunk.hasVoxelData) {
			if (runStart !== -1) flushRun(y + 1);
			continue;
		}
		const ly = worldToBlockCoord(y);
		const block = chunk.getBlock(lx, ly, lz);
		const packed = chunk.getLight(lx, ly, lz);
		const sky = getSkyLight(packed);
		const blockLight = getBlockLight(packed);
		if (
			runStart !== -1 &&
			runLoaded &&
			block === runBlock &&
			sky === runSky &&
			blockLight === runBlockLight
		) {
			continue;
		}
		flushRun(y + 1);
		runStart = y;
		runBlock = block;
		runSky = sky;
		runBlockLight = blockLight;
		runLoaded = true;
	}
	flushRun(py - 40);
	console.log(lines.join("\n"));
}
