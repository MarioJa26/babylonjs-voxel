import { playExplosionSound } from "@/code/Audio/TntAudio";
import type { Mob } from "@/code/Entities/Mobs/Mob";
import {
	playExplosion,
	playExplosionDebris,
	playLandingDust,
	playMobDeath,
} from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import { getOnExplosion } from "@/code/Player/Hud/BlockHighlight/BreakingBlockHandler";
import type { Player } from "@/code/Player/Player";
import { Gamemodes } from "@/code/Player/PlayerStats";
import { Chunk } from "@/code/World/Chunk/Chunk";
import {
	deleteBlock,
	getBlockByWorldCoords,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import {
	blastMobDamages,
	collectExplosionTargets,
	explosionFalloff,
	TNT_BLAST_RADIUS,
	TNT_MAX_DAMAGE,
} from "@/code/World/ExplosionSim";

/** Ignites a live TNT block with a short fuse (chain reactions). */
export type ChainIgniter = (x: number, y: number, z: number) => void;

/** Screen-flash half range: apparent brightness halves past this distance. */
const SCREEN_FLASH_HALF_RANGE = 16;

export interface ExplodeOptions {
	/** Blast radius in blocks (default TNT_BLAST_RADIUS = 4). */
	radius?: number;
	/** Damage at the blast center (default TNT_MAX_DAMAGE = 40). */
	maxDamage?: number;
	/** Local player: takes damage, knockback and screen shake. Defaults to Map1.mainPlayer; pass explicit null for FX-only. */
	player?: Player | null;
	/** Called for live TNT inside the blast so it detonates shortly after. */
	chainIgniter?: ChainIgniter | null;
	/** Max destroyed blocks emitting terrain debris (particle pool guard). */
	maxBurstBlocks?: number;
	/**
	 * Send the single Explosion message to the server (default true).
	 * Remote (relayed) detonations pass false: the lighting client already
	 * owns the authoritative crater.
	 */
	syncExplosion?: boolean;
}

export interface ExplosionResult {
	destroyed: number;
	chained: number;
}

// Full-screen blast flash (same HTML-overlay technique as UnderWaterEffect —
// Lite WebGPU exposes no post-process pipeline).
let flashOverlay: HTMLDivElement | null = null;
let flashTimer: number | null = null;

const SCREEN_FLASH_HALF_RANGE_SQUARED =
	SCREEN_FLASH_HALF_RANGE * SCREEN_FLASH_HALF_RANGE;

function fadeFlashOverlay(): void {
	flashTimer = null;

	if (!flashOverlay) {
		return;
	}

	flashOverlay.style.transition = "opacity 220ms ease-out";
	flashOverlay.style.opacity = "0";
}

function flashScreen(strength: number): void {
	try {
		if (!flashOverlay) {
			const overlay = document.createElement("div");

			overlay.style.position = "fixed";
			overlay.style.inset = "0";
			overlay.style.pointerEvents = "none";
			overlay.style.zIndex = "60";
			overlay.style.opacity = "0";
			overlay.style.background =
				"radial-gradient(ellipse at center, rgba(255,240,200,0.9) 0%, rgba(255,160,60,0.45) 55%, rgba(255,120,20,0.15) 100%)";

			document.body.appendChild(overlay);
			flashOverlay = overlay;
		}

		if (flashTimer !== null) {
			window.clearTimeout(flashTimer);
		}

		flashOverlay.style.transition = "none";
		flashOverlay.style.opacity = String(
			0.55 * Math.min(1, Math.max(0, strength)),
		);

		flashTimer = window.setTimeout(fadeFlashOverlay, 40);
	} catch {
		// Flash must never break gameplay.
	}
}

/**
 * Detonate a blast at (cx, cy, cz): vaporize blocks, ignite chained TNT,
 * damage + knock back the player and mobs, and play FX.
 *
 * Block edits go through the standard ChunkLoadingSystem path (remesh +
 * water updates included). In multiplayer the crater is synced with ONE
 * Explosion message (see onExplosion): per-block Break notifies would be
 * rejected as TooFar for blocks past the normal reach and rolled back.
 * A future batch-compression pass could pack the crater into the message —
 * the call site is the single getOnExplosion() call below.
 */
export function explode(
	cx: number,
	cy: number,
	cz: number,
	options: ExplodeOptions = {},
): ExplosionResult {
	const radius = options.radius ?? TNT_BLAST_RADIUS;
	const maxDamage = options.maxDamage ?? TNT_MAX_DAMAGE;
	const igniter = options.chainIgniter ?? null;

	const { destroy, chain } = collectExplosionTargets(
		cx,
		cy,
		cz,
		radius,
		getBlockByWorldCoords,
	);

	const destroyLength = destroy.length;
	const chainLength = chain.length;
	const destroyChainAsTerrain = igniter === null;
	const destroyed = destroyLength + (destroyChainAsTerrain ? chainLength : 0);
	const chained = destroyChainAsTerrain ? 0 : chainLength;

	// Keep the two target arrays separate. This avoids growing `destroy`
	// to create a temporary combined list when chained TNT is terrain.
	Chunk.beginBlockEditBatch();

	try {
		if (igniter !== null) {
			for (let i = 0; i < chainLength; i++) {
				const target = chain[i];
				igniter(target.x, target.y, target.z);
			}
		}

		for (let i = 0; i < destroyLength; i++) {
			const target = destroy[i];
			deleteBlock(target.x, target.y, target.z);
		}

		if (destroyChainAsTerrain) {
			for (let i = 0; i < chainLength; i++) {
				const target = chain[i];
				deleteBlock(target.x, target.y, target.z);
			}
		}
	} finally {
		Chunk.endBlockEditBatch();
	}

	if (options.syncExplosion !== false) {
		getOnExplosion()?.(cx, cy, cz, radius);
	}

	const packedLight = getLightByWorldCoords(cx, cy, cz);

	playExplosion(cx, cy, cz, radius, packedLight);

	const maxBurstBlocks = options.maxBurstBlocks ?? 8;
	const debrisCount =
		maxBurstBlocks > 0 && destroyed > 0
			? Math.min(maxBurstBlocks, destroyed)
			: 0;

	if (debrisCount > 0) {
		const debrisPower = 1 + radius / TNT_BLAST_RADIUS;
		const debrisStep = destroyed / debrisCount;

		for (let i = 0; i < debrisCount; i++) {
			const targetIndex = Math.floor(i * debrisStep);
			const target =
				targetIndex < destroyLength
					? destroy[targetIndex]
					: chain[targetIndex - destroyLength];

			playExplosionDebris(
				target.x + 0.5,
				target.y + 0.5,
				target.z + 0.5,
				target.blockId,
				packedLight,
				debrisPower,
			);
		}
	}

	playLandingDust(cx, cy, cz, radius * 2);
	playExplosionSound(1);

	// Undefined selects the current local player. Explicit null means FX-only.
	const player =
		options.player === undefined ? Map1.mainPlayer : options.player;

	let flashStrength = 1;

	if (player !== null) {
		const position = player.position;
		const dx = position.x - cx;
		const dy = position.y + 0.9 - cy;
		const dz = position.z - cz;
		const distanceSquared = dx * dx + dy * dy + dz * dz;
		const distance = Math.sqrt(distanceSquared);
		const falloff = explosionFalloff(distance, radius);

		if (falloff > 0) {
			if (player.stats.gamemode !== Gamemodes.Creative) {
				player.stats.takeDamage(Math.floor(falloff * maxDamage));
			}

			const force = falloff * 11;
			const inverseDistance = 1 / Math.max(distance, 0.5);
			const scaledForce = inverseDistance * force;

			player.playerVehicle.addExplosionImpulse(
				dx * scaledForce,
				(dy * inverseDistance * 0.6 + 0.65) * force,
				dz * scaledForce,
			);

			player.playerCamera.addTrauma(Math.min(1, falloff + 0.25));
		} else {
			const rumble = explosionFalloff(distance, radius * 2.5);

			if (rumble > 0) {
				player.playerCamera.addTrauma(rumble * 0.4);
			}
		}

		flashStrength =
			1.5 / (1 + distanceSquared / SCREEN_FLASH_HALF_RANGE_SQUARED);

		if (flashStrength < 0.05) {
			flashStrength = 0;
		}
	}

	if (flashStrength > 0) {
		flashScreen(flashStrength);
	}

	const registry = Map1.mobRegistry;

	if (registry) {
		/*
		 * These arrays remain necessary because blastMobDamages accepts a
		 * position array, while applying its results requires retaining the
		 * matching mob for each position.
		 *
		 * Per-call arrays are safer than module-level scratch buffers because
		 * mob.takeDamage may synchronously cause another explosion.
		 */
		const liveMobs: Mob[] = [];
		const mobPositions: Mob["position"][] = [];

		for (const mob of registry.getAllMobs()) {
			if (!mob.isDisposed) {
				liveMobs.push(mob);
				mobPositions.push(mob.position);
			}
		}

		const mobCount = liveMobs.length;

		if (mobCount > 0) {
			const damages = blastMobDamages(
				mobPositions,
				cx,
				cy,
				cz,
				radius,
				maxDamage,
			);

			for (let i = 0; i < mobCount; i++) {
				const damage = damages[i];

				if (damage <= 0) {
					continue;
				}

				const mob = liveMobs[i];
				const position = mob.position;
				const x = position.x;
				const y = position.y;
				const z = position.z;

				// Keep this object per call in case takeDamage retains it.
				mob.takeDamage(damage, { x, y, z });

				if (mob.isDisposed) {
					playMobDeath(x, y, z);
				}
			}
		}
	}

	return { destroyed, chained };
}
