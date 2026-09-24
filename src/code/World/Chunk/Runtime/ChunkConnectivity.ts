import { GenerationParams } from "@/code/Generation/NoiseAndParameters/GenerationParams";
import {
	connectFacesMask,
	FACE_CONNECT_THRESHOLD,
} from "../Meshing/ChunkFaceMasks";
import { unpackBlockId } from "../DataStructures/BlockEncoding";
import { BLOCK_TYPE } from "../Worker/ChunkMesherConstants";

const SIZE = GenerationParams.CHUNK_SIZE;
const SIZE2 = SIZE * SIZE;
const SIZE3 = SIZE * SIZE * SIZE;
const MAX = SIZE - 1;
const FULL_CONNECTIVITY = connectFacesMask(0x3f);
const USE_FAST_COORDINATES = SIZE === 32;
const visited = new Uint8Array(SIZE3);
const stack = new Int32Array(SIZE3);
const faceCounts = new Uint16Array(6);

function premarkOpaque(
	blocks: Uint8Array | Uint16Array,
	paletteOpacity: Uint8Array | null,
): void {
	if (paletteOpacity !== null && blocks instanceof Uint8Array) {
		for (let i = 0; i < SIZE3; i++) {
			const byte = blocks[i >>> 1];
			const nibble = (i & 1) === 0 ? byte & 0x0f : byte >>> 4;
			visited[i] = paletteOpacity[nibble];
		}
		return;
	}

	if (blocks instanceof Uint16Array) {
		for (let i = 0; i < SIZE3; i++) {
			const packed = blocks[i];
			visited[i] =
				packed !== 0 && BLOCK_TYPE[unpackBlockId(packed)] === 0 ? 1 : 0;
		}
		return;
	}

	for (let i = 0; i < SIZE3; i++) {
		visited[i] = blocks[i] !== 0 && BLOCK_TYPE[blocks[i]] === 0 ? 1 : 0;
	}
}

function computeConnectivity(): number {
	let connectivity = 0;

	for (let z = 0; z < SIZE; z++) {
		const zBase = z * SIZE2;
		for (let y = 0; y < SIZE; y++) {
			const yzBase = zBase + y * SIZE;
			for (let x = 0; x < SIZE; x++) {
				const index = yzBase + x;
				if (visited[index] !== 0) continue;

				let stackSize = 1;
				stack[0] = index;
				visited[index] = 1;
				faceCounts.fill(0);

				while (stackSize > 0) {
					const current = stack[--stackSize];
					let cx: number;
					let cy: number;
					let cz: number;

					if (USE_FAST_COORDINATES) {
						cx = current & 31;
						cy = (current >>> 5) & 31;
						cz = current >>> 10;
					} else {
						cz = Math.floor(current / SIZE2);
						const remainder = current - cz * SIZE2;
						cy = Math.floor(remainder / SIZE);
						cx = remainder - cy * SIZE;
					}

					if (cx === 0) faceCounts[1]++;
					if (cx === MAX) faceCounts[0]++;
					if (cy === 0) faceCounts[3]++;
					if (cy === MAX) faceCounts[2]++;
					if (cz === 0) faceCounts[5]++;
					if (cz === MAX) faceCounts[4]++;

					if (cx > 0) {
						const next = current - 1;
						if (visited[next] === 0) {
							visited[next] = 1;
							stack[stackSize++] = next;
						}
					}
					if (cx < MAX) {
						const next = current + 1;
						if (visited[next] === 0) {
							visited[next] = 1;
							stack[stackSize++] = next;
						}
					}
					if (cy > 0) {
						const next = current - SIZE;
						if (visited[next] === 0) {
							visited[next] = 1;
							stack[stackSize++] = next;
						}
					}
					if (cy < MAX) {
						const next = current + SIZE;
						if (visited[next] === 0) {
							visited[next] = 1;
							stack[stackSize++] = next;
						}
					}
					if (cz > 0) {
						const next = current - SIZE2;
						if (visited[next] === 0) {
							visited[next] = 1;
							stack[stackSize++] = next;
						}
					}
					if (cz < MAX) {
						const next = current + SIZE2;
						if (visited[next] === 0) {
							visited[next] = 1;
							stack[stackSize++] = next;
						}
					}
				}

				let openFaces = 0;
				if (faceCounts[0] >= FACE_CONNECT_THRESHOLD) openFaces |= 1;
				if (faceCounts[1] >= FACE_CONNECT_THRESHOLD) openFaces |= 2;
				if (faceCounts[2] >= FACE_CONNECT_THRESHOLD) openFaces |= 4;
				if (faceCounts[3] >= FACE_CONNECT_THRESHOLD) openFaces |= 8;
				if (faceCounts[4] >= FACE_CONNECT_THRESHOLD) openFaces |= 16;
				if (faceCounts[5] >= FACE_CONNECT_THRESHOLD) openFaces |= 32;

				if (openFaces !== 0) {
					connectivity |= connectFacesMask(openFaces);
					if (connectivity === FULL_CONNECTIVITY) return connectivity;
				}
			}
		}
	}

	return connectivity;
}

export function computeStoredFaceConnectivity(
	blocks: Uint8Array | Uint16Array,
	paletteOpacity: Uint8Array | null,
): number {
	premarkOpaque(blocks, paletteOpacity);
	return computeConnectivity();
}
