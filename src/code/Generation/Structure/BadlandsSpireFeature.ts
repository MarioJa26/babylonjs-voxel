import { BlockType } from "../../World/Texture/BlockType";
import { BIOME_ID, type Biome } from "../Biome/BiomeTypes";
import { createFastNoise3DWithInstance } from "../NoiseAndParameters/FastNoise/FastNoiseFactory";
import { FractalType } from "../NoiseAndParameters/FastNoise/FastNoiseLite";
import { Squirrel3 } from "../NoiseAndParameters/Squirrel13";
import { getBiome, getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver, IWorldFeature } from "./IWorldFeature";
import { aabbOverlaps, chunkWorldBounds, computeRegion } from "./RegionFeature";

const MIN_SPIRE_HEIGHT = 120;
const MAX_SPIRE_HEIGHT = 600;
const SUPERELLIPSE_EXP = 2.8;
const SPIRE_FOOTPRINT = 64;

const TIER_A = [32, 27, 22, 17, 12, 7];
const TIER_B = [22, 18, 15, 12, 8, 4];
const TIER_COUNT = TIER_A.length;

const NOISE_FREQ = 0.025;
const NOISE_AMPLITUDE = 0.2;
const NOISE_OFFSET_SCALE = 0.1;
const CAVE_FREQ = 0.04;
const CAVE_OCTAVES = 1;

const GRID_SIZE = 4;
const GRID_SIZE_1 = GRID_SIZE - 1;
const GRID_CELLS = GRID_SIZE * GRID_SIZE;

// Cave grid — 8×8 bilinear
const CAVE_GRID = 8;

// Reusable flat arrays for bilinear lookups
const _shapeGrid = new Float32Array(GRID_CELLS);
const _caveGrid = new Float32Array(CAVE_GRID * CAVE_GRID);

// ── Noise instances ──────────────────────────────────────────────────────────

const shapeNoiseResult = createFastNoise3DWithInstance({
	seed: 42,
	frequency: NOISE_FREQ,
	fractalType: FractalType.Ridged,
});
shapeNoiseResult.instance.SetFractalOctaves(2);
const shapeNoise = shapeNoiseResult.fn;

const caveNoiseResult = createFastNoise3DWithInstance({
	seed: 99,
	frequency: CAVE_FREQ,
	fractalType: FractalType.Ridged,
});
caveNoiseResult.instance.SetFractalOctaves(CAVE_OCTAVES);
const caveNoise = caveNoiseResult.fn;

// ── Layer palette ────────────────────────────────────────────────────────────

const LAYERS: readonly number[] = [
	BlockType.TerracottaBlock,
	BlockType.RedSandstoneWall,
	BlockType.Cobble,
];

export class BadlandsSpireFeature implements IWorldFeature {
	public readonly verticalBounds = {
		minWorldY: -200,
		maxWorldY: 500 + MAX_SPIRE_HEIGHT + 8,
	};
	public readonly maxAboveSurface = MAX_SPIRE_HEIGHT + 20;

	public generate(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		biome: Biome,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		seed: number,
		chunkSize: number,
		generatingChunkX: number,
		generatingChunkZ: number,
		columnPrepassResolver?: ColumnPrepassResolver,
	) {
		if (biome.id !== BIOME_ID.BADLANDS) return;

		const region = computeRegion(chunkX, chunkZ, chunkSize, seed, {
			regionSize: 4,
			magicA: 1457932807,
			magicB: 892467153,
			spawnChance: 90,
			earlyReturn: false,
		});
		if (!region) return;

		const { centerX: spireX, centerZ: spireZ } = region;

		const bounds = chunkWorldBounds(
			generatingChunkX,
			generatingChunkZ,
			chunkSize,
		);

		const maxDisp = Math.ceil(TIER_A[0] * NOISE_AMPLITUDE) + 2;
		if (
			!aabbOverlaps(
				spireX - maxDisp,
				spireX + SPIRE_FOOTPRINT + maxDisp,
				spireZ - maxDisp,
				spireZ + SPIRE_FOOTPRINT + maxDisp,
				bounds.minX,
				bounds.maxX,
				bounds.minZ,
				bounds.maxZ,
			)
		)
			return;

		const halfFp = SPIRE_FOOTPRINT / 2;
		const cx = spireX + halfFp;
		const cz = spireZ + halfFp;

		const centerBiome = getBiome(cx, cz);
		if (centerBiome.id !== BIOME_ID.BADLANDS) return;
		const edgeOffsets: [number, number][] = [
			[-SPIRE_FOOTPRINT, 0],
			[SPIRE_FOOTPRINT, 0],
			[0, -SPIRE_FOOTPRINT],
			[0, SPIRE_FOOTPRINT],
		];
		for (const [ox, oz] of edgeOffsets) {
			if (getBiome(cx + ox, cz + oz).id !== BIOME_ID.BADLANDS) return;
		}

		const heightHash = Squirrel3.get(spireX * 7 + spireZ * 13, seed);
		const spireHeight =
			MIN_SPIRE_HEIGHT +
			(Math.abs(heightHash) % (MAX_SPIRE_HEIGHT - MIN_SPIRE_HEIGHT + 1));
		const tierHeight = Math.floor(spireHeight / TIER_COUNT);

		const groundHeight = this.findGroundHeight(
			spireX,
			spireZ,
			halfFp,
			columnPrepassResolver,
		);

		this.generateSpire(
			chunkX,
			chunkY,
			chunkZ,
			spireX,
			spireZ,
			groundHeight,
			spireHeight,
			tierHeight,
			halfFp,
			placeBlock,
			chunkSize,
			seed,
		);
	}

	private generateSpire(
		chunkX: number,
		chunkY: number,
		chunkZ: number,
		spireX: number,
		spireZ: number,
		groundHeight: number,
		spireHeight: number,
		tierHeight: number,
		halfFp: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		chunkSize: number,
		seed: number,
	) {
		const chunkWorldY = chunkY * chunkSize;
		const centerX = spireX + halfFp;
		const centerZ = spireZ + halfFp;

		const noiseOffX = spireX * NOISE_OFFSET_SCALE;
		const noiseOffZ = spireZ * NOISE_OFFSET_SCALE;

		for (let localY = 0; localY < chunkSize; localY++) {
			const worldY = chunkWorldY + localY;

			if (worldY >= groundHeight && worldY < groundHeight + spireHeight) {
				this.generateTierSlice(
					worldY,
					groundHeight,
					tierHeight,
					centerX,
					centerZ,
					noiseOffX,
					noiseOffZ,
					placeBlock,
					seed,
				);
			}
		}
	}

	private generateTierSlice(
		worldY: number,
		groundHeight: number,
		tierHeight: number,
		centerX: number,
		centerZ: number,
		noiseOffX: number,
		noiseOffZ: number,
		placeBlock: (
			x: number,
			y: number,
			z: number,
			id: number,
			ow: boolean,
		) => void,
		seed: number,
	) {
		const spireLocalY = worldY - groundHeight;

		const tierFloat = spireLocalY / tierHeight;
		const tierIndex = Math.min(Math.floor(tierFloat), TIER_COUNT - 1);
		const tierLocalY = spireLocalY - tierIndex * tierHeight;

		const rawT = tierLocalY / tierHeight;
		const s = rawT * rawT * (3 - 2 * rawT);

		const iNext = Math.min(tierIndex + 1, TIER_COUNT - 1);

		const adjA = TIER_A[tierIndex] + (TIER_A[iNext] - TIER_A[tierIndex]) * s;
		const adjB = TIER_B[tierIndex] + (TIER_B[iNext] - TIER_B[tierIndex]) * s;

		const hCurr = Squirrel3.get(tierIndex * 9973, seed);
		const hNext = Squirrel3.get(iNext * 9973, seed);
		const cAx = (Math.abs(hCurr) % 7) - 3;
		const cAz = (Math.abs(hCurr >> 8) % 7) - 3;
		const nAx = (Math.abs(hNext) % 7) - 3;
		const nAz = (Math.abs(hNext >> 8) % 7) - 3;
		const offsetX = cAx + (nAx - cAx) * s;
		const offsetZ = cAz + (nAz - cAz) * s;

		const layerBlockId = this.getLayerBlock(spireLocalY, seed);
		const maxR = Math.ceil(adjA * (1 + NOISE_AMPLITUDE) + 2);

		const gridMin = -maxR;
		const gridSpan = maxR * 2;
		const gridStep = gridSpan / GRID_SIZE_1;

		// ── Hoist: Shape & Cave Grids (Only 16 noise calls each per slice!) ──
		for (let gy = 0; gy < GRID_SIZE; gy++) {
			const sampleZ = centerZ + gridMin + gy * gridStep + noiseOffZ;
			const rowOffset = gy * GRID_SIZE;

			for (let gx = 0; gx < GRID_SIZE; gx++) {
				const sampleX = centerX + gridMin + gx * gridStep + noiseOffX;
				const idx = rowOffset + gx;

				// Shape Noise Grid
				_shapeGrid[idx] = shapeNoise(sampleX * 0.01, worldY, sampleZ * 0.01);

				// Cave Noise Grid
				_caveGrid[idx] = caveNoise(sampleX, worldY * 0.8, sampleZ);
			}
		}

		// ── Inner Loop: Zero Noise Calls, Zero Trigonometry ──────────────────
		const invGridSpan = 1.0 / gridSpan;

		for (let dx = -maxR; dx <= maxR; dx++) {
			const dxTier = dx - offsetX;
			const nx = Math.abs(dxTier) / adjA;
			const nxExp = nx ** SUPERELLIPSE_EXP;

			// Pre-calculate horizontal grid interpolation weights
			const gx = (dx - gridMin) * invGridSpan * GRID_SIZE_1;
			const gxi = gx | 0;
			const gxf = gx - gxi;
			const gxi1 = gxi < GRID_SIZE_1 ? gxi + 1 : GRID_SIZE_1;

			const wX0 = 1 - gxf;
			const wX1 = gxf;

			for (let dz = -maxR; dz <= maxR; dz++) {
				const dzTier = dz - offsetZ;
				const nz = Math.abs(dzTier) / adjB;
				const dist = nxExp + nz ** SUPERELLIPSE_EXP;

				// Vertical grid interpolation weights
				const gz = (dz - gridMin) * invGridSpan * GRID_SIZE_1;
				const gzi = gz | 0;
				const gzf = gz - gzi;
				const gzi1 = gzi < GRID_SIZE_1 ? gzi + 1 : GRID_SIZE_1;

				const wZ0 = 1 - gzf;
				const wZ1 = gzf;

				// Fast Bilinear Lookup for Shape Noise
				const r0 = gzi * GRID_SIZE;
				const r1 = gzi1 * GRID_SIZE;

				const shapeN =
					(_shapeGrid[r0 + gxi] * wX0 + _shapeGrid[r0 + gxi1] * wX1) * wZ0 +
					(_shapeGrid[r1 + gxi] * wX0 + _shapeGrid[r1 + gxi1] * wX1) * wZ1;

				if (dist > 1.0 + shapeN * NOISE_AMPLITUDE) continue;

				// Fast Bilinear Lookup for Cave Noise
				const caveN =
					(_caveGrid[r0 + gxi] * wX0 + _caveGrid[r0 + gxi1] * wX1) * wZ0 +
					(_caveGrid[r1 + gxi] * wX0 + _caveGrid[r1 + gxi1] * wX1) * wZ1;

				if (caveN > 0.8 - dist * 0.5) continue;

				placeBlock(centerX + dx, worldY, centerZ + dz, layerBlockId, true);
			}
		}
	}

	private getLayerBlock(spireLocalY: number, seed: number): number {
		const bandSeed = Squirrel3.get(spireLocalY * 49157, seed);
		const bandThickness = 3 + (Math.abs(bandSeed) % 6);
		const layerIndex = Math.floor(spireLocalY / bandThickness);
		return LAYERS[layerIndex % LAYERS.length];
	}

	private findGroundHeight(
		x: number,
		z: number,
		halfFp: number,
		columnPrepassResolver?: ColumnPrepassResolver,
	): number {
		const getH = (wx: number, wz: number): number => {
			if (columnPrepassResolver) {
				const resolved = columnPrepassResolver(wx, wz);
				return resolved.entry.terrainHeightMap[
					resolved.localX + resolved.localZ * 32
				];
			}
			return getFinalTerrainHeight(wx, wz);
		};

		let minH = getH(x + halfFp, z + halfFp);
		const offsets: [number, number][] = [
			[halfFp, 0],
			[-halfFp, 0],
			[0, halfFp],
			[0, -halfFp],
			[halfFp, halfFp],
			[-halfFp, halfFp],
			[halfFp, -halfFp],
			[-halfFp, -halfFp],
		];
		for (const [dx, dz] of offsets) {
			const h = getH(x + halfFp + dx, z + halfFp + dz);
			if (h < minH) minH = h;
		}
		return minH;
	}
}
