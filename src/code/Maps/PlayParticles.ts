import type { Vec3 } from "@babylonjs/lite";
import {
	getBlockByWorldCoords,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { getPRNGUnit2 } from "../Generation/NoiseAndParameters/Squirrel13";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { BlockFaceTileX, BlockFaceTileY } from "../World/Texture/BlockTextures";
import { BlockType, isCollidableBlock } from "../World/Texture/BlockType";
import { FaceName } from "../World/Texture/FaceName";
import { atlasSize } from "../World/Texture/TextureAtlasFactory";
import { addParticle, isParticlesReady, type Rgb } from "./Particles";

const PARTICLES_PER_BREAK = 198;

const MINING_PARTICLES_PER_EMIT = 6;
const MINING_PARTICLE_INTERVAL_MS = 67;

const PLACE_PARTICLES_PER_EMIT = 20;

const SPRINT_PARTICLES_PER_EMIT = 6;
const SPRINT_PARTICLE_INTERVAL_MS = 120;

// Minimum horizontal speed before a sprinting player kicks up dust.
const SPRINT_MIN_SPEED_SQ = 66;
// Feet offset subtracted from a player's body origin to land dust at the ground.
const SPRINT_FEET_OFFSET = 0.85;

/**
 * Per-emitter throttle state. Sprint dust is emitted by the local player and
 * every remote player from locally-available interpolated motion, so each
 * emitter keeps its own cadence instead of contending on a shared timer.
 */
export interface SprintEmitterState {
	lastSprintEmitMs: number;
}

export function makeSprintEmitterState(): SprintEmitterState {
	return { lastSprintEmitMs: 0 };
}

export { SPRINT_FEET_OFFSET, SPRINT_MIN_SPEED_SQ };

const ARROW_PARTICLES_PER_EMIT = 8;
const ARROW_PARTICLE_INTERVAL_MS = 75;

// Wound drip while an arrow rides a mob: slow red trickle from the impact.
// Throttling is CALLER-side (per stuck arrow), so any number of wounded mobs
// can drip simultaneously — see MOB_DRIP_INTERVAL_MS.
export const MOB_DRIP_INTERVAL_MS = 240;
const MOB_DRIPS_PER_EMIT = 24;
const MOB_DAMAGE_PARTICLES_MIN = 4;
const MOB_DAMAGE_PARTICLES_PER_POINT = 6;
const MOB_DAMAGE_PARTICLES_MAX = 32;
const MOB_BLOOD_BLOCK = BlockType.CoralBlock;

const DEBRIS_PER_BREAK = 32;
const DEBRIS_PER_EXPLOSION = 96;

let lastMiningEmitMs = 0;
let lastArrowHitEmitMs = 0;

// Block id -> atlas frame index, precomputed once. Reads typed arrays directly.
const blockFrameLUT = buildBlockFrameLUT();

function buildBlockFrameLUT(): Uint16Array {
	const count = BlockFaceTileX.length / FaceName.Count;
	const lut = new Uint16Array(count);
	for (let id = 0; id < count; id++) {
		const base = id * FaceName.Count + FaceName.All;
		const tx = BlockFaceTileX[base];
		const ty = BlockFaceTileY[base];
		// atlasSize may still be 0 at module init; fallback to 16 (matches atlasSize default)
		const size = atlasSize || 16;
		lut[id] = ty * size + tx;
	}
	return lut;
}

function getBlockFrame(blockId: number): number {
	return blockFrameLUT[blockId] ?? 0;
}

/** Scratch light result reused across every `computeLight` call. Safe because
 * every call site consumes `.r/.g/.b` immediately and never holds the
 * reference across a subsequent `computeLight` call. */
const scratchLight = { r: 0, g: 0, b: 0 };

function computeLight(packedLight: number): Rgb {
	const skyLight = ((packedLight >> 4) & 0xf) / 15;
	const blockLight = (packedLight & 0xf) / 15;

	const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
	const sunLightIntensity = Math.min(1.0, Math.max(0.0, sunElevation * 4.0));
	const skyScale = sunLightIntensity + 0.3;

	const skyRGB = skyLight * 0.8 * skyScale;

	const blockR = blockLight * 0.9;
	const blockG = blockLight * 0.6;
	const blockB = blockLight * 0.2;

	scratchLight.r = Math.min(1, Math.max(0.2, skyRGB + blockR));
	scratchLight.g = Math.min(1, Math.max(0.2, skyRGB + blockG));
	scratchLight.b = Math.min(1, Math.max(0.2, skyRGB + blockB));
	return scratchLight;
}

/**
 * Effect fidelity, chosen per emission rather than per system.
 *
 * PERF/RATIONALE: before this, every emitter ran at full fidelity and the only
 * limits were the hard pool cap and per-emitter interval throttles. Neither
 * scales with distance or with load. A remote block edit emitted `play()` +
 * `playDebris()` = 230 particles, so a 2048-edit join snapshot asked for
 * ~470k particles against an 8192-slot pool — the pool silently dropped them
 * after doing the per-particle work, and the survivors were whichever arrived
 * first rather than whichever mattered.
 */
export const enum ParticleQuality {
	None,
	/** A few particles, no debris, no collision. */
	Minimal,
	/** Full burst, debris without collision. */
	Normal,
	/** Full burst plus colliding, settling debris. */
	Full,
}

/**
 * Pick a fidelity for a block edit, given where it happened, how loaded the
 * pool already is, and how many edits arrived together.
 *
 * The two independent axes matter: `distanceSq` bounds how much the player can
 * see, `batchSize` bounds how many bursts the frame will contain. An explosion
 * 30 blocks away is close but arrives as a 400-edit batch, so it degrades on
 * the batch axis alone — the visibility tier would have allowed Full.
 */
export function chooseBlockEditParticleQuality(
	distanceSq: number,
	activeParticles: number,
	batchSize: number,
): ParticleQuality {
	// Beyond the particle visibility horizon, emit nothing at all.
	if (distanceSq > PARTICLE_CULL_DIST_SQ) return ParticleQuality.None;

	// A large batch, or an already-saturated pool, collapses to Minimal. Both
	// mean this burst is one of many competing for the same slots.
	if (
		batchSize > BATCH_PARTICLE_LIMIT ||
		activeParticles > PARTICLE_SATURATION_COUNT
	) {
		return ParticleQuality.Minimal;
	}

	// Mid-range: the burst is visible but debris collision is not worth the
	// voxel sweep for blocks the player will not walk up to.
	if (distanceSq > PARTICLE_FULL_DIST_SQ) return ParticleQuality.Normal;

	return ParticleQuality.Full;
}

/** Distance beyond which no particles are emitted at all. */
const PARTICLE_CULL_DIST_SQ = 160 * 160;
/** Inside this distance a single edit earns full fidelity. */
const PARTICLE_FULL_DIST_SQ = 48 * 48;
/** A batch larger than this is treated as a mass event. */
const BATCH_PARTICLE_LIMIT = 128;
/** Alive count above which new bursts degrade regardless of distance. */
const PARTICLE_SATURATION_COUNT = 7000;

/** Fraction of the burst emitted at each quality. `Full` is the reference. */
const QUALITY_BURST_SCALE = [0, 0.06, 0.35, 1] as const;

export function play(
	position: Vec3,
	blockId: number,
	packedLight: number,
): void {
	if (!isParticlesReady()) return;

	spawnBurst(
		position.x,
		position.y,
		position.z,
		getBlockFrame(blockId),
		computeLight(packedLight),
	);
}

/**
 * Quality-scaled break burst.
 *
 * Callers handling many edits at once should emit a few of these rather than
 * one per block — see `NetworkManager.applyRemoteBlockEdits`.
 */
export function playScaled(
	position: Vec3,
	blockId: number,
	packedLight: number,
	quality: ParticleQuality,
): void {
	if (quality === ParticleQuality.None || !isParticlesReady()) return;

	const count = Math.max(
		1,
		Math.round(PARTICLES_PER_BREAK * QUALITY_BURST_SCALE[quality]),
	);

	spawnBurstCount(
		position.x,
		position.y,
		position.z,
		getBlockFrame(blockId),
		computeLight(packedLight),
		count,
	);
}

/**
 * Bouncy debris kicked out of a broken block. Particles collide with the voxel
 * world (shape-aware: slabs/stairs/fences), bounce with restitution, and settle
 * to rest on surfaces where they fade out. `x/y/z` is the broken block center.
 */
export function playDebris(
	x: number,
	y: number,
	z: number,
	blockId: number,
	packedLight: number,
): void {
	if (!isParticlesReady()) return;

	const light = computeLight(packedLight);

	spawnDebrisBurst(x, y, z, getBlockFrame(blockId), light.r, light.g, light.b);
}

/**
 * Quality-scaled debris.
 *
 * Debris is the expensive half of a break: every particle carries the collide
 * flag, and each one runs a shape-aware voxel sweep every frame until it
 * settles. Below `Full`, debris is suppressed entirely — the burst alone
 * still reads as a break, and the voxel sweeps are what actually cost.
 */
export function playDebrisScaled(
	x: number,
	y: number,
	z: number,
	blockId: number,
	packedLight: number,
	quality: ParticleQuality,
): void {
	if (quality !== ParticleQuality.Full || !isParticlesReady()) return;

	const light = computeLight(packedLight);

	spawnDebrisBurst(x, y, z, getBlockFrame(blockId), light.r, light.g, light.b);
}

/**
 * Small dust puff when a block is placed. Deliberately subtler than the
 * break burst (fewer, smaller, slower, shorter-lived particles, no voxel
 * collision — the freshly placed block is solid, so colliding debris would
 * instantly stick). `x/y/z` is the placed block center.
 */
export function playPlace(
	x: number,
	y: number,
	z: number,
	blockId: number,
	packedLight: number,
): void {
	playPlaceScaled(x, y, z, blockId, packedLight, ParticleQuality.Full);
}

/** Quality-scaled placement puff. */
export function playPlaceScaled(
	x: number,
	y: number,
	z: number,
	blockId: number,
	packedLight: number,
	quality: ParticleQuality,
): void {
	if (quality === ParticleQuality.None || !isParticlesReady()) return;

	const frame = getBlockFrame(blockId);
	const light = computeLight(packedLight);
	const shade = 0.85 + getPRNGUnit2() * 0.15;

	const count = Math.max(
		1,
		Math.round(PLACE_PARTICLES_PER_EMIT * QUALITY_BURST_SCALE[quality]),
	);

	for (let i = 0; i < count; i++) {
		const angle = getPRNGUnit2() * Math.PI * 2;
		const outSpeed = 1.7 + getPRNGUnit2();

		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.7,
			y + (getPRNGUnit2() - 0.5),
			z + (getPRNGUnit2() - 0.5) * 0.7,
			Math.cos(angle) * outSpeed,
			0.75 + getPRNGUnit2() * 1.2,
			Math.sin(angle) * outSpeed,
			0.85 + getPRNGUnit2(),
			0.06 + getPRNGUnit2() * 0.124,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 3,
			frame,
			light.r * shade,
			light.g * shade,
			light.b * shade,
			1,
			1,
		);
	}
}

/**
 * Violent omnidirectional debris for explosions: terrain chunks launched in
 * ALL directions (uniform sphere — up, down, sideways) at high speed, arcing
 * under full gravity and bouncing off the voxel world. Unlike playDebris
 * (a mining-strength pop with an upward bias), this is true blast scatter —
 * including downward chunks that slam into the crater floor and ricochet. A
 * quarter of the chunks are fire-tinted burning debris. `x/y/z` is the burst
 * center (destroyed block center); `power` scales launch speed (1 = TNT).
 */
export function playExplosionDebris(
	x: number,
	y: number,
	z: number,
	blockId: number,
	packedLight: number,
	power = 1,
): void {
	if (!isParticlesReady()) return;

	const frame = getBlockFrame(blockId);
	const light = computeLight(packedLight);
	let life = 1 + getPRNGUnit2();

	for (let i = 0; i < DEBRIS_PER_EXPLOSION; i++) {
		const theta = getPRNGUnit2() * Math.PI * 2;
		const up = getPRNGUnit2() * 2;
		const speed = (6 + getPRNGUnit2() * 8) * power;
		const burning = getPRNGUnit2() < 0.25;
		const shade = 0.8 + getPRNGUnit2() * 0.25;
		life += 0.06;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.9,
			y + (getPRNGUnit2() - 0.5) * 0.9,
			z + (getPRNGUnit2() - 0.5) * 0.9,
			Math.cos(theta) * speed,
			up * speed,
			Math.sin(theta) * speed,
			life,
			0.1 + getPRNGUnit2() * 0.1,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 6,
			frame,
			burning ? 1.2 : light.r * shade,
			burning ? 0.5 : light.g * shade,
			burning ? 0.18 : light.b * shade,
			1,
			1,
			1,
		);
	}
}

/**
 * Sparks that pop out of the block face while it is being mined. Emission is
 * throttled internally, so the caller may call this every frame. `x/y/z` is the
 * face center (block center + normal * 0.5) and `nx/ny/nz` the face normal.
 */
export function playMining(
	x: number,
	y: number,
	z: number,
	nx: number,
	ny: number,
	nz: number,
	blockId: number,
): void {
	if (!isParticlesReady()) return;

	const now = performance.now();
	if (now - lastMiningEmitMs < MINING_PARTICLE_INTERVAL_MS) return;
	lastMiningEmitMs = now;

	const frame = getBlockFrame(blockId);

	// Sample light one more half-block out along the normal: `x/y/z` is the
	// face boundary, which floors into the mined (solid) block for half of the
	// faces — that voxel stores no light, so particles came out black there.
	// `face center + normal * 0.5` lands in the adjacent air block, which is
	// lit, for every face (same spot the block-break burst samples).
	const light = computeLight(
		getLightByWorldCoords(x + nx * 0.5, y + ny * 0.5, z + nz * 0.5),
	);
	const lr = light.r;
	const lg = light.g;
	const lb = light.b;

	for (let i = 0; i < MINING_PARTICLES_PER_EMIT; i++) {
		const jx = (getPRNGUnit2() - 0.5) * 0.5;
		const jy = (getPRNGUnit2() - 0.5) * 0.5;
		const jz = (getPRNGUnit2() - 0.5) * 0.5;
		const speed = 0.5 + getPRNGUnit2();
		addParticle(
			x + jx,
			y + jy,
			z + jz,
			nx * speed + jx * 0.6,
			ny * speed + 0.35 + jy * 0.6,
			nz * speed + jz * 0.6,
			0.3 + getPRNGUnit2() * 0.25,
			0.04 + getPRNGUnit2() * 0.03,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr,
			lg,
			lb,
			1,
			0.6,
		);
	}
}

export function playArrowHit(
	x: number,
	y: number,
	z: number,
	nx: number,
	ny: number,
	nz: number,
	blockId: number,
): void {
	if (!isParticlesReady()) return;

	const now = performance.now();
	if (now - lastArrowHitEmitMs < ARROW_PARTICLE_INTERVAL_MS) return;
	lastArrowHitEmitMs = now;

	const frame = getBlockFrame(blockId);

	// Sample light one more half-block out along the normal: `x/y/z` is the
	// face boundary, which floors into the mined (solid) block for half of the
	// faces — that voxel stores no light, so particles came out black there.
	// `face center + normal * 0.5` lands in the adjacent air block, which is
	// lit, for every face (same spot the block-break burst samples).
	const light = computeLight(
		getLightByWorldCoords(x + nx * 0.5, y + ny * 0.5, z + nz * 0.5),
	);
	const lr = light.r;
	const lg = light.g;
	const lb = light.b;
	let life = 0.4 + getPRNGUnit2();

	for (let i = 0; i < ARROW_PARTICLES_PER_EMIT; i++) {
		const jx = (getPRNGUnit2() - 0.25) * 0.25;
		const jy = (getPRNGUnit2() - 0.3) * 0.3;
		const jz = (getPRNGUnit2() - 0.25) * 0.25;
		const speed = 0.66 + getPRNGUnit2();
		life += 0.1;
		addParticle(
			x + jx,
			y + jy,
			z + jz,
			nx * speed + jx * 0.6,
			ny * speed + 0.35 + jy * 0.6,
			nz * speed + jz * 0.6,
			life,
			0.04 + getPRNGUnit2() * 0.03,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr,
			lg,
			lb,
			1,
			0.5,
		);
		addParticle(
			x + jx,
			y + jy,
			z + jz,
			nx * speed + jx * 0.6,
			ny * speed + 0.35 + jy * 0.6,
			nz * speed + jz * 0.6,
			life,
			0.04 + getPRNGUnit2() * 0.03,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr,
			lg,
			lb,
			1,
			0.5,
			1,
		);
	}
}

/**
 * Slow red trickle from a wound — spawns droplets at the given point.
 * Stateless by design: the CALLER throttles per emitter (each stuck arrow
 * keeps its own timer against MOB_DRIP_INTERVAL_MS), so any number of wounded
 * mobs can drip at the same time. `x/y/z` is the arrow tip. Drips fall under
 * gravity, collide with the voxel world and settle briefly before fading.
 *
 * @param damage Dealt per emit — scales the number of droplets so harder
 *   hits bleed more. Defaults to 1 (base MOB_DRIPS_PER_EMIT droplets).
 */
export function playMobDrip(
	x: number,
	y: number,
	z: number,
	damage = 0.5,
): void {
	if (!isParticlesReady()) return;

	const frame = getBlockFrame(MOB_BLOOD_BLOCK);
	const light = computeLight(getLightByWorldCoords(x, y - 0.25, z));
	const bloodR = light.r * 1.0;
	const bloodG = light.g * 0.3;
	const bloodB = light.b * 0.24;
	// Scale particle count with damage, clamped to a sane range.
	const count = Math.min(
		MOB_DRIPS_PER_EMIT,
		Math.max(1, Math.round(MOB_DRIPS_PER_EMIT * Math.max(0, damage))),
	);

	let life = 10.33 + getPRNGUnit2();
	for (let i = 0; i < count; i++) {
		life += 0.1;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.1,
			y + (getPRNGUnit2() - 0.5) * 0.1,
			z + (getPRNGUnit2() - 0.5) * 0.1,
			(getPRNGUnit2() - 0.5) * 0.4,
			getPRNGUnit2() * 2,
			(getPRNGUnit2() - 0.5) * 0.4,
			life,
			0.04 + getPRNGUnit2() * 0.02,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 2,
			frame,
			bloodR,
			bloodG,
			bloodB,
			1,
			1,
			1,
		);
	}
}

/** Short blood burst when a mob takes direct damage. */
export function playMobDamage(
	x: number,
	y: number,
	z: number,
	damage: number,
): void {
	spawnBloodBurst(x, y, z, damage, 0, 0, false);
}

const FIRE_PARTICLE_FRAMES = [164, 246, 247, 252] as const;

/** Small animated flame tongues used to show that a mob is burning. */
export function playMobFire(
	x: number,
	y: number,
	z: number,
	height: number,
): void {
	if (!isParticlesReady()) return;

	const light = computeLight(getLightByWorldCoords(x, y, z));
	const safeHeight = Math.max(0.5, height);
	const count = Math.max(2, Math.min(4, Math.ceil(safeHeight * 1.5)));

	for (let i = 0; i < count; i++) {
		const frame =
			FIRE_PARTICLE_FRAMES[
				Math.floor(getPRNGUnit2() * FIRE_PARTICLE_FRAMES.length)
			]!;
		const angle = getPRNGUnit2() * Math.PI * 2;
		const radius = 0.12 + getPRNGUnit2() * 0.18;

		addParticle(
			x + Math.cos(angle) * radius,
			y - safeHeight * 0.45 + getPRNGUnit2() * safeHeight * 0.9,
			z + Math.sin(angle) * radius,
			Math.cos(angle) * 0.25 + (getPRNGUnit2() - 0.5) * 0.2,
			0.35 + getPRNGUnit2() * 0.55,
			Math.sin(angle) * 0.25 + (getPRNGUnit2() - 0.5) * 0.2,
			0.24 + getPRNGUnit2() * 0.16,
			0.16 + getPRNGUnit2() * 0.16,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 3,
			frame,
			light.r,
			light.g,
			light.b,
			1,
			0,
		);
	}
}

/**
 * Directional blood burst for when the PLAYER takes a melee hit: the spray
 * travels along (dirX, dirZ) with a small random spread, so the hit reads
 * as coming from a direction instead of a generic omnidirectional pop.
 * Callers pass the mob→player facing negated, blowing the spray back
 * toward the attacker so it stays in front of the camera. Falls back to
 * +X when the direction is degenerate.
 */
export function playMobDamageDirected(
	x: number,
	y: number,
	z: number,
	damage: number,
	dirX: number,
	dirZ: number,
): void {
	spawnBloodBurst(x, y, z, damage, dirX, dirZ, true);
}

// Engine perf: per-hit burst (a few/sec max). Single shared loop for
// omnidirectional and directional sprays; one predictable branch per particle
// selects the velocity model. Frame/light/tint/count computed once.
function spawnBloodBurst(
	x: number,
	y: number,
	z: number,
	damage: number,
	dirX: number,
	dirZ: number,
	directed: boolean,
): void {
	if (!isParticlesReady() || !Number.isFinite(damage) || damage <= 0) return;

	let dx = dirX;
	let dz = dirZ;
	if (directed) {
		const len = Math.sqrt(dx * dx + dz * dz);
		if (!(len > 0.0001) || !Number.isFinite(len)) {
			dx = 1;
			dz = 0;
		} else {
			dx /= len;
			dz /= len;
		}
	}

	const frame = getBlockFrame(MOB_BLOOD_BLOCK);
	const light = computeLight(getLightByWorldCoords(x, y, z));
	// Use a dedicated red atlas tile for the initial hit burst and reinforce it
	// with a blood-red tint so it cannot look like the coral drip effect.
	const bloodR = light.r * 1.0;
	const bloodG = light.g * 0.3;
	const bloodB = light.b * 0.24;
	const count = Math.min(
		MOB_DAMAGE_PARTICLES_MAX,
		Math.max(
			MOB_DAMAGE_PARTICLES_MIN,
			Math.ceil(damage * MOB_DAMAGE_PARTICLES_PER_POINT),
		),
	);

	for (let i = 0; i < count; i++) {
		let vx: number;
		let vz: number;
		if (directed) {
			// Forward cone along the hit direction plus lateral jitter.
			const forward = 0.8 + getPRNGUnit2() * 1.2;
			const lateral = (getPRNGUnit2() - 0.5) * 1.1;
			vx = dx * forward - dz * lateral;
			vz = dz * forward + dx * lateral;
		} else {
			const angle = getPRNGUnit2() * Math.PI * 2;
			const speed = 0.25 + getPRNGUnit2() * 0.65;
			vx = Math.cos(angle) * speed;
			vz = Math.sin(angle) * speed;
		}
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.18,
			y + (getPRNGUnit2() - 0.5) * 0.22,
			z + (getPRNGUnit2() - 0.5) * 0.18,
			vx,
			0.45 + getPRNGUnit2() * 1.1,
			vz,
			0.3 + getPRNGUnit2() * 0.45,
			0.035 + getPRNGUnit2() * 0.025,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 3,
			frame,
			bloodR,
			bloodG,
			bloodB,
			1,
			1,
			1,
		);
	}
}

const MOB_DEATH_PARTICLES = 48;

/**
 * Violent blood burst when a mob is killed outright (explosions, heavy
 * hits). Bigger, faster, and longer-lived than the playMobDamage hit spray
 * so a kill reads clearly even inside explosion FX; chunks bounce
 * off the voxel world and settle like debris.
 */
export function playMobDeath(x: number, y: number, z: number): void {
	if (!isParticlesReady()) return;

	const frame = getBlockFrame(MOB_BLOOD_BLOCK);
	const light = computeLight(getLightByWorldCoords(x, y, z));
	const bloodR = light.r * 1.0;
	const bloodG = light.g * 0.3;
	const bloodB = light.b * 0.24;
	let life = 2 + getPRNGUnit2();

	for (let i = 0; i < MOB_DEATH_PARTICLES; i++) {
		const theta = getPRNGUnit2() * Math.PI * 2;
		const up = getPRNGUnit2() * 2;
		const speed = 1 + getPRNGUnit2() * 2.5;
		life += 0.1;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.3,
			y + (getPRNGUnit2() - 0.5) * 0.4,
			z + (getPRNGUnit2() - 0.5) * 0.3,
			Math.cos(theta) * speed,
			up * speed,
			Math.sin(theta) * speed,
			life,
			0.125,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 6,
			frame,
			bloodR,
			bloodG,
			bloodB,
			1,
			1,
			1,
		);
	}
}

/**
 * Footstep dust kicked up behind a sprinting player. `x/y/z` is the feet
 * position and `velX/velZ` the world-space horizontal movement vector; dust
 * drifts opposite to it.
 */
export function playSprint(
	emitter: SprintEmitterState,
	x: number,
	y: number,
	z: number,
	velX: number,
	velZ: number,
): void {
	if (!isParticlesReady()) return;

	const now = performance.now();
	if (now - emitter.lastSprintEmitMs < SPRINT_PARTICLE_INTERVAL_MS) return;

	// Dust picks up the block underfoot: frame + tint come from the ground
	// block at the feet, so it changes with the terrain instead of always
	// showing the same tile. No block underfoot (air / unloaded chunk) means
	// no dust — e.g. while falling or flying over open air.
	const groundBlockId = getBlockByWorldCoords(
		Math.floor(x),
		Math.floor(y - 0.05),
		Math.floor(z),
	);
	if (groundBlockId === 0) return;
	const frame = getBlockFrame(groundBlockId);
	const light = computeLight(getLightByWorldCoords(x, y, z));
	const lr = light.r;
	const lg = light.g;
	const lb = light.b;

	emitter.lastSprintEmitMs = now;

	const speed = Math.max(0.0001, Math.hypot(velX, velZ));
	const dirX = velX / speed;
	const dirZ = velZ / speed;

	const count = SPRINT_PARTICLES_PER_EMIT + Math.floor(getPRNGUnit2() * 2);
	for (let i = 0; i < count; i++) {
		const shade = 0.8 + getPRNGUnit2() * 0.2;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.5,
			y + 0.12,
			z + (getPRNGUnit2() - 0.5) * 0.5,
			-dirX * (0.4 + getPRNGUnit2() * 0.7) + (getPRNGUnit2() - 0.5) * 0.4,
			0.34,
			-dirZ * (0.4 + getPRNGUnit2() * 0.7) + (getPRNGUnit2() - 0.5) * 0.4,
			0.35 + getPRNGUnit2() * 0.3,
			0.1,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr * shade,
			lg * shade,
			lb * shade,
			1.0,
			0.08,
		);
	}
}

/**
 * Landing dust kicked up when a mob hits the ground after a fall. `x/y/z` is
 * the landing point (physical ground contact); particle count scales with fall
 * distance so harder landings throw up more dust. The particles use the tile
 * and lighting of the block that was actually hit.
 */
export function playLandingDust(
	x: number,
	y: number,
	z: number,
	fallDistance: number,
): void {
	if (
		!isParticlesReady() ||
		!Number.isFinite(fallDistance) ||
		fallDistance <= 0
	)
		return;

	// `y` is the physical contact height. Sample the voxel immediately below
	// it so the puff uses the block that was actually hit, not a hard-coded
	// atlas tile (and never accidentally samples air at the surface boundary).
	let groundBlockId = getBlockByWorldCoords(
		Math.floor(x),
		Math.floor(y - 0.05),
		Math.floor(z),
	);
	if (!isCollidableBlock(groundBlockId)) {
		// Pass-through cover (tall grass, snow layers) or a fall that
		// outran chunk streaming — the collider treats unloaded chunks as
		// solid, so the landing is real but the query reads air. Scan down
		// for the first solid block so the puff still matches the terrain;
		// with nothing loaded yet, fall back to generic dust instead of
		// silently emitting nothing.
		groundBlockId = 0;
		const groundY = Math.floor(y - 0.05);
		for (let d = 1; d <= 6; d++) {
			const id = getBlockByWorldCoords(
				Math.floor(x),
				groundY - d,
				Math.floor(z),
			);
			if (isCollidableBlock(id)) {
				groundBlockId = id;
				break;
			}
		}
		if (groundBlockId === 0) groundBlockId = BlockType.GravellySand;
	}

	const frame = getBlockFrame(groundBlockId);
	const light = computeLight(getLightByWorldCoords(x, y + 0.05, z));
	const shade = 0.85 + getPRNGUnit2() * 0.15;
	const lr = light.r * shade;
	const lg = light.g * shade;
	const lb = light.b * shade;

	// Scale particle count with fall distance: a 3-block fall makes a small
	// puff, a 20-block drop kicks up a big cloud. Clamped to the pool.
	const count = Math.min(
		PARTICLES_PER_BREAK,
		Math.max(8, Math.round(fallDistance * 12)),
	);

	// Clamp the fall distance driving initial speeds: count already caps at
	// 198, so unbounded speeds would spread very high falls over a huge disc
	// that disperses in under a second and reads as no particles. Capped
	// falls still render as a big dense lingering cloud.
	const speedFall = Math.min(fallDistance, 64);
	let life = 0.4 + getPRNGUnit2();

	for (let i = 0; i < count; i++) {
		const angle = getPRNGUnit2() * Math.PI * 2;
		const outSpeed = 0.3 + getPRNGUnit2() * (0.4 + speedFall * 0.15);
		life += 0.04;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.6,
			y + 0.03,
			z + (getPRNGUnit2() - 0.5) * 0.6,
			Math.cos(angle) * outSpeed,
			0.4 + getPRNGUnit2() * (0.6 + speedFall * 0.3),
			Math.sin(angle) * outSpeed,
			life,
			0.08 + getPRNGUnit2() * 0.06,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			lr,
			lg,
			lb,
			1.0,
			0.8,
			1,
		);
	}
}

const EXPLOSION_SMOKE_PER_RADIUS = 22;
const EXPLOSION_SMOKE_MAX = 110;
const EXPLOSION_EMBER_COUNT = 60;
const EXPLOSION_RING_COUNT = 48;

/**
 * Full explosion look: core flash, layered fireball, ground shockwave ring,
 * rising smoke column, and bouncing embers. `x/y/z` is the blast center.
 *
 * Deliberately NOT block-break bursts (those read as mining): the fire and
 * smoke use the TNT atlas tile purely as chunky filler, tinted per phase.
 * Terrain chunks come from a few capped playDebris() calls by the detonator.
 * Total budget stays well under POOL_SIZE so chained blasts don't starve.
 */
export function playExplosion(
	x: number,
	y: number,
	z: number,
	radius: number,
	packedLight: number,
	intensity = 1,
): void {
	if (!isParticlesReady()) return;

	const frame = getBlockFrame(BlockType.CastleBrickRed);
	const light = computeLight(packedLight);
	const lr = Math.min(1, light.r + 0.35);
	const lg = Math.min(1, light.g + 0.35);
	const lb = Math.min(1, light.b + 0.35);
	const speedScale = 0.7 + radius * 0.15;

	/*
	 * Fidelity multiplier, 0..1.
	 *
	 * An explosion emits ~350 particles: 1 flash + 24 sparks + ~114 fireball +
	 * 48 ring + up to 110 smoke + 60 embers. At Medium distance none of that is
	 * individually resolvable, but the cost is identical, and several
	 * simultaneous blasts would each pay it in full.
	 *
	 * Scales the COUNT of every layer, not just the size, because size is
	 * bounded by the shared pool either way while count is what competes for
	 * slots and collision budget.
	 */
	const scale = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;

	const scaled = (count: number): number =>
		Math.max(1, Math.round(count * scale));

	// --- 1. Core flash: one huge white billboard, gone in a blink. ---
	addParticle(
		x,
		y,
		z,
		0,
		0.5,
		0,
		0.1,
		radius,
		y,
		lr,
		frame,
		2.5,
		2.4,
		2.2,
		1,
		0,
	);

	// --- 2. Hot sparks: white-yellow, fast, very short. ---
	for (let i = 0, n = scaled(24); i < n; i++) {
		const theta = getPRNGUnit2() * Math.PI * 2;
		const up = getPRNGUnit2() * 2 - 1;
		const flat = Math.sqrt(Math.max(0, 1 - up * up));
		const speed = (4 + getPRNGUnit2() * 5) * speedScale;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.8,
			y + (getPRNGUnit2() - 0.5) * 0.8,
			z + (getPRNGUnit2() - 0.5) * 0.8,
			Math.cos(theta) * flat * speed,
			up * speed + 1,
			Math.sin(theta) * flat * speed,
			0.2 + getPRNGUnit2() * 0.15,
			0.1 + getPRNGUnit2() * 0.1,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			1.4,
			1.1,
			0.65,
			1,
			0.1,
		);
	}

	// --- 3. Fireball: three shells, white-hot inside → deep red outside. ---
	spawnFireShell(
		x,
		y,
		z,
		frame,
		scaled(30),
		1.3,
		0.9,
		0.45,
		2,
		6,
		0.3,
		0.5,
		0.15,
		0.28,
		0,
		speedScale,
	);
	spawnFireShell(
		x,
		y,
		z,
		frame,
		scaled(48),
		1.2,
		0.55,
		0.2,
		1.5,
		5,
		0.45,
		0.7,
		0.18,
		0.32,
		-0.1,
		speedScale,
	);
	spawnFireShell(
		x,
		y,
		z,
		frame,
		scaled(36),
		0.9,
		0.3,
		0.12,
		1,
		3.5,
		0.6,
		0.9,
		0.2,
		0.36,
		-0.15,
		speedScale,
	);

	// --- 4. Shockwave ring: fast dusty disc hugging the ground. ---
	for (let i = 0, n = scaled(EXPLOSION_RING_COUNT); i < n; i++) {
		const angle = getPRNGUnit2() * Math.PI * 2;
		const speed = (7 + getPRNGUnit2() * 6) * speedScale;
		const shade = 0.55 + getPRNGUnit2() * 0.25;
		addParticle(
			x + Math.cos(angle) * 0.5,
			y + 0.2,
			z + Math.sin(angle) * 0.5,
			Math.cos(angle) * speed,
			0.3 + getPRNGUnit2() * 0.9,
			Math.sin(angle) * speed,
			0.35 + getPRNGUnit2() * 0.2,
			0.18 + getPRNGUnit2() * 0.12,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			shade * lr,
			shade * lg * 0.9,
			shade * lb * 0.75,
			1,
			0.15,
		);
	}

	// --- 5. Smoke column: dark, slow, long-lived, drifting up. ---
	const smokeCount = scaled(
		Math.min(
			EXPLOSION_SMOKE_MAX,
			Math.max(8, Math.floor(radius * EXPLOSION_SMOKE_PER_RADIUS)),
		),
	);
	for (let i = 0; i < smokeCount; i++) {
		const angle = getPRNGUnit2() * Math.PI * 2;
		const outSpeed = 0.5 + getPRNGUnit2() * (1 + radius * 0.4);
		const shade = 0.13 + getPRNGUnit2() * 0.1;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * radius,
			y + (getPRNGUnit2() - 0.5) * 0.8,
			z + (getPRNGUnit2() - 0.5) * radius,
			Math.cos(angle) * outSpeed,
			1.2 + getPRNGUnit2() * 2.2,
			Math.sin(angle) * outSpeed,
			1.7 + getPRNGUnit2() * 1.4,
			0.2 + getPRNGUnit2() * 0.22,
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			shade * lr,
			shade * lg,
			shade * lb,
			1,
			-0.1,
			1,
		);
	}

	// --- 6. Embers: tiny bright sparks that arc out and bounce on landing. ---
	for (let i = 0, n = scaled(EXPLOSION_EMBER_COUNT); i < n; i++) {
		const theta = getPRNGUnit2() * Math.PI * 2;
		const flat = 0.4 + getPRNGUnit2() * 0.6;
		const speed = (4 + getPRNGUnit2() * 7) * speedScale;
		addParticle(
			x,
			y + 0.3,
			z,
			Math.cos(theta) * flat * speed,
			(1.5 + getPRNGUnit2() * 3.5) * speedScale,
			Math.sin(theta) * flat * speed,
			0.6 + getPRNGUnit2() * 0.8,
			0.04 + getPRNGUnit2() * 0.04,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 6,
			frame,
			1.2,
			0.45 + getPRNGUnit2() * 0.2,
			0.12,
			1,
			1.1,
			1,
		);
	}
}

/**
 * One fireball shell: uniformly-distributed sphere velocities, shared tint,
 * randomized ranges. `grav` is the particle gravity scale (negative rises).
 */
function spawnFireShell(
	x: number,
	y: number,
	z: number,
	frame: number,
	count: number,
	r: number,
	g: number,
	b: number,
	minSpeed: number,
	maxSpeed: number,
	minLife: number,
	maxLife: number,
	minSize: number,
	maxSize: number,
	grav: number,
	speedScale: number,
): void {
	for (let i = 0; i < count; i++) {
		const theta = getPRNGUnit2() * Math.PI * 2;
		const up = getPRNGUnit2() * 2 - 1;
		const flat = Math.sqrt(Math.max(0, 1 - up * up));
		const speed =
			(minSpeed + getPRNGUnit2() * (maxSpeed - minSpeed)) * speedScale;
		const flicker = 0.85 + getPRNGUnit2() * 0.3;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.9,
			y + (getPRNGUnit2() - 0.5) * 0.9,
			z + (getPRNGUnit2() - 0.5) * 0.9,
			Math.cos(theta) * flat * speed,
			up * speed + 1.2,
			Math.sin(theta) * flat * speed,
			minLife + getPRNGUnit2() * (maxLife - minLife),
			minSize + getPRNGUnit2() * (maxSize - minSize),
			getPRNGUnit2() * Math.PI * 2,
			getPRNGUnit2() - 0.5,
			frame,
			r * flicker,
			g * flicker,
			b * flicker,
			1,
			grav,
		);
	}
}

function spawnBurst(
	x: number,
	y: number,
	z: number,
	frame: number,
	light: Rgb,
): void {
	spawnBurstCount(x, y, z, frame, light, PARTICLES_PER_BREAK);
}

/** Shared body of the break burst, parameterised by how many particles. */
function spawnBurstCount(
	x: number,
	y: number,
	z: number,
	frame: number,
	light: Rgb,
	count: number,
): void {
	for (let i = 0; i < count; i++) {
		const shade = 0.7 + getPRNGUnit2() * 0.3;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.8,
			y + (getPRNGUnit2() - 0.5) * 0.8,
			z + (getPRNGUnit2() - 0.5) * 0.8,
			(getPRNGUnit2() - 0.5) * 2.8,
			getPRNGUnit2() * 4.0,
			(getPRNGUnit2() - 0.5) * 2.8,
			0.75 + getPRNGUnit2() * 0.9,
			0.053 + getPRNGUnit2() * 0.08,
			getPRNGUnit2(),
			getPRNGUnit2() - 0.5,
			frame,
			light.r * shade,
			light.g * shade,
			light.b * shade,
			1,
			1,
		);
	}
}

function spawnDebrisBurst(
	x: number,
	y: number,
	z: number,
	frame: number,
	r: number,
	g: number,
	b: number,
): void {
	for (let i = 0; i < DEBRIS_PER_BREAK; i++) {
		const shade = 0.8 + getPRNGUnit2() * 0.25;
		addParticle(
			x + (getPRNGUnit2() - 0.5) * 0.8,
			y + 0.15,
			z + (getPRNGUnit2() - 0.5) * 0.8,
			(getPRNGUnit2() - 0.5) * 2.2,
			1.4 + getPRNGUnit2() * 2.2,
			(getPRNGUnit2() - 0.5) * 2.2,
			1.3 + getPRNGUnit2() * 1.2,
			0.06 + getPRNGUnit2() * 0.07,
			getPRNGUnit2() * Math.PI * 2,
			(getPRNGUnit2() - 0.5) * 3,
			frame,
			r * shade,
			g * shade,
			b * shade,
			1,
			1,
			1,
		);
	}
}
