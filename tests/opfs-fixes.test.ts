/**
 * Standalone tests for OPFS / Chunk Storage fixes.
 * Run with: npx tsx tests/opfs-fixes.test.ts
 *
 * Tests pure functions only (packChunkKey, unpackChunkKey).
 * OPFS-dependent tests (RegionFile, OpfsChunkStore) must be verified in-browser.
 */

import {
	packChunkKey,
	unpackChunkKey,
} from "../src/code/World/Storage/ChunkKey";

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

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
