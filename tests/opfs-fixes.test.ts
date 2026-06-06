/**
 * Standalone tests for OPFS / Chunk Storage fixes.
 * Run with: npx tsx tests/opfs-fixes.test.ts
 *
 * Tests pure functions only (packChunkKey, unpackChunkKey, MeshSerializer).
 * OPFS-dependent tests (RegionFile, OpfsChunkStore) must be verified in-browser.
 */

import { MeshData } from "../src/code/World/Chunk/DataStructures/MeshData";
import {
	packChunkKey,
	unpackChunkKey,
} from "../src/code/World/Storage/ChunkKey";
import {
	deserializeMesh,
	deserializeMeshPair,
	serializeMesh,
	serializeMeshPair,
} from "../src/code/World/Storage/MeshSerializer";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
	if (condition) {
		passed++;
	} else {
		failed++;
		console.error(`  FAIL: ${msg}`);
	}
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
	if (actual === expected) {
		passed++;
	} else {
		failed++;
		console.error(`  FAIL: ${msg} — expected ${expected}, got ${actual}`);
	}
}

function assertThrows(fn: () => void, msg: string): void {
	try {
		fn();
		failed++;
		console.error(`  FAIL: ${msg} — expected throw but did not throw`);
	} catch {
		passed++;
	}
}

// ─── ChunkKey roundtrip tests ───────────────────────────────────────────────

console.log("ChunkKey roundtrip tests...");

for (const [x, y, z] of [
	[0, 0, 0],
	[-1, 0, 0],
	[0, -1, 0],
	[0, 0, -1],
	[-752, 1, 1085],
	[1048575, 1048575, 1048575],
	[-1048576, -1048576, -1048576],
	[1, 2, 3],
	[-1, -2, -3],
	[42, -100, 999],
]) {
	const key = packChunkKey(x, y, z);
	const u = unpackChunkKey(key);
	assertEq(u.chunkX, x, `packChunkKey(${x},${y},${z}) chunkX`);
	assertEq(u.chunkY, y, `packChunkKey(${x},${y},${z}) chunkY`);
	assertEq(u.chunkZ, z, `packChunkKey(${x},${y},${z}) chunkZ`);
}

// ─── ChunkKey uniqueness tests ──────────────────────────────────────────────

console.log("ChunkKey uniqueness tests...");

const keySet = new Set<bigint>();
const testCoords = [
	[0, 0, 0],
	[1, 0, 0],
	[-1, 0, 0],
	[0, 1, 0],
	[0, -1, 0],
	[0, 0, 1],
	[0, 0, -1],
	[100, 200, 300],
	[-100, -200, -300],
];
for (const [x, y, z] of testCoords) {
	const key = packChunkKey(x, y, z);
	assert(!keySet.has(key), `unique key for (${x},${y},${z})`);
	keySet.add(key);
}
assertEq(keySet.size, testCoords.length, "all keys unique");

// ─── ChunkKey validation ────────────────────────────────────────────────────

console.log("ChunkKey validation tests...");

assertThrows(() => packChunkKey(1048576, 0, 0), "chunkX > max throws");
assertThrows(() => packChunkKey(-1048577, 0, 0), "chunkX < min throws");
assertThrows(() => packChunkKey(0, 1048576, 0), "chunkY > max throws");
assertThrows(() => packChunkKey(0, 0, 1048576), "chunkZ > max throws");

// ─── MeshSerializer tests ───────────────────────────────────────────────────

console.log("MeshSerializer roundtrip tests...");

function makeMesh(
	faceCount: number,
	aLen: number,
	bLen: number,
	cLen: number,
): MeshData {
	const mesh = new MeshData();
	mesh.faceCount = faceCount;
	mesh.faceDataA = new Uint8Array(aLen);
	mesh.faceDataB = new Uint8Array(bLen);
	mesh.faceDataC = new Uint8Array(cLen);
	for (let i = 0; i < aLen; i++) mesh.faceDataA[i] = i & 0xff;
	for (let i = 0; i < bLen; i++) mesh.faceDataB[i] = (i + 10) & 0xff;
	for (let i = 0; i < cLen; i++) mesh.faceDataC[i] = (i + 20) & 0xff;
	return mesh;
}

// Empty mesh
{
	const mesh = makeMesh(0, 0, 0, 0);
	const bytes = serializeMesh(mesh)!;
	assert(bytes !== null, "serializeMesh empty returns non-null");
	const decoded = deserializeMesh(bytes);
	assertEq(decoded.faceCount, 0, "empty mesh faceCount");
	assertEq(decoded.faceDataA.length, 0, "empty mesh faceDataA length");
	assertEq(decoded.faceDataB.length, 0, "empty mesh faceDataB length");
	assertEq(decoded.faceDataC.length, 0, "empty mesh faceDataC length");
}

// Non-empty mesh
{
	const mesh = makeMesh(42, 100, 200, 50);
	const bytes = serializeMesh(mesh)!;
	const decoded = deserializeMesh(bytes);
	assertEq(decoded.faceCount, 42, "non-empty mesh faceCount");
	assertEq(decoded.faceDataA.length, 100, "non-empty mesh faceDataA length");
	assertEq(decoded.faceDataB.length, 200, "non-empty mesh faceDataB length");
	assertEq(decoded.faceDataC.length, 50, "non-empty mesh faceDataC length");
	// Verify data content
	for (let i = 0; i < 100; i++) {
		assertEq(decoded.faceDataA[i], i & 0xff, `faceDataA[${i}]`);
	}
}

// MeshSerializer validation — too short
{
	assertThrows(
		() => deserializeMesh(new Uint8Array(8)),
		"deserializeMesh too short throws",
	);
}

// MeshSerializer validation — declared too large
{
	const buf = new Uint8Array(20);
	const dv = new DataView(buf.buffer);
	dv.setUint32(0, 1, true); // faceCount
	dv.setUint32(4, 1000, true); // aLen way too big
	dv.setUint32(8, 0, true);
	dv.setUint32(12, 0, true);
	assertThrows(
		() => deserializeMesh(buf),
		"deserializeMesh declared too large throws",
	);
}

// ─── MeshPair roundtrip ─────────────────────────────────────────────────────

console.log("MeshPair roundtrip tests...");

{
	const opaque = makeMesh(10, 30, 40, 50);
	const transparent = makeMesh(5, 10, 15, 20);
	const bytes = serializeMeshPair(opaque, transparent)!;
	const decoded = deserializeMeshPair(bytes, 2);
	assert(decoded.opaque !== null, "mesh pair has opaque");
	assert(decoded.transparent !== null, "mesh pair has transparent");
	assertEq(decoded.lod, 2, "mesh pair lod preserved");
	assertEq(decoded.opaque!.faceCount, 10, "mesh pair opaque faceCount");
	assertEq(
		decoded.transparent!.faceCount,
		5,
		"mesh pair transparent faceCount",
	);
}

// MeshPair validation — too short
{
	assertThrows(
		() => deserializeMeshPair(new Uint8Array(5), 0),
		"deserializeMeshPair too short throws",
	);
}

// MeshPair validation — declared too large
{
	const buf = new Uint8Array(14);
	const dv = new DataView(buf.buffer);
	dv.setUint8(0, 1); // hasO
	dv.setUint8(1, 0); // no transparent
	dv.setUint32(2, 9999, true); // oLen way too big
	dv.setUint32(6, 0, true);
	assertThrows(
		() => deserializeMeshPair(buf, 0),
		"deserializeMeshPair declared too large throws",
	);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
