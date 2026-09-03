import type { Vec3 } from "@babylonjs/lite";
import {
	play,
	playDebris,
	playExplosion,
	playLandingDust,
} from "@/code/Maps/BlockBreakParticles";
import { Map1 } from "@/code/Maps/Map1";
import { getOnBlockBroken } from "@/code/Player/Hud/BlockHighlight/BreakingBlockHandler";
import type { Player } from "@/code/Player/Player";
import { Gamemodes } from "@/code/Player/PlayerStats";
import {
	deleteBlock,
	getBlockByWorldCoords,
	getLightByWorldCoords,
} from "@/code/World/Chunk/ChunkLoadingSystem";
import { playExplosionSound } from "@/code/World/ExplosionAudio";
import {
	collectExplosionTargets,
	explosionFalloff,
	TNT_BLAST_RADIUS,
	TNT_MAX_DAMAGE,
} from "@/code/World/ExplosionSim";

/** Ignites a live TNT block with a short fuse (chain reactions). */
export type ChainIgniter = (x: number, y: number, z: number) => void;

export interface ExplodeOptions {
	/** Blast radius in blocks (default TNT_BLAST_RADIUS = 4). */
	radius?: number;
	/** Damage at the blast center (default TNT_MAX_DAMAGE = 40). */
	maxDamage?: number;
	/** Local player: takes damage, knockback and screen shake. Defaults to Map1.mainPlayer; pass explicit null for FX-only. */
	player?: Player | null;
	/** Called for live TNT inside the blast so it detonates shortly after. */
	chainIgniter?: ChainIgniter | null;
	/** Max destroyed blocks emitting full break bursts (particle pool guard). */
	maxBurstBlocks?: number;
}

export interface ExplosionResult {
	destroyed: number;
	chained: number;
}

// Full-screen blast flash (same HTML-overlay technique as UnderWaterEffect —
// Lite WebGPU exposes no post-process pipeline).
let flashOverlay: HTMLDivElement | null = null;
let flashTimer: number | null = null;

function flashScreen(strength: number): void {
	if (typeof document === "undefined") return;

	try {
		if (!flashOverlay) {
			flashOverlay = document.createElement("div");
			flashOverlay.style.position = "fixed";
			flashOverlay.style.inset = "0";
			flashOverlay.style.pointerEvents = "none";
			flashOverlay.style.zIndex = "60";
			flashOverlay.style.opacity = "0";
			flashOverlay.style.background =
				"radial-gradient(ellipse at center, rgba(255,240,200,0.9) 0%, rgba(255,160,60,0.45) 55%, rgba(255,120,20,0.15) 100%)";
			document.body.appendChild(flashOverlay);
		}

		if (flashTimer !== null) {
			window.clearTimeout(flashTimer);
			flashTimer = null;
		}
		flashOverlay.style.transition = "none";
		flashOverlay.style.opacity = String(
			0.55 * Math.min(1, Math.max(0, strength)),
		);

		flashTimer = window.setTimeout(() => {
			if (!flashOverlay) return;
			flashOverlay.style.transition = "opacity 220ms ease-out";
			flashOverlay.style.opacity = "0";
		}, 40);
	} catch {
		// Flash must never break gameplay.
	}
}

/**
 * Detonate a blast at (cx, cy, cz): vaporize blocks, ignite chained TNT,
 * damage + knock back the player and mobs, and play FX.
 *
 * Block edits go through the standard ChunkLoadingSystem path (remesh +
 * water updates included) and are reported through the multiplayer
 * block-broken callback. A future server-authoritative `Explosion` message
 * should replace the per-block notify loop (see NetworkManager
 * BlockEditBatch) — the call site is this single loop below.
 */
export function explode(
	cx: number,
	cy: number,
	cz: number,
	options: ExplodeOptions = {},
): ExplosionResult {
	const radius = options.radius ?? TNT_BLAST_RADIUS;
	const maxDamage = options.maxDamage ?? TNT_MAX_DAMAGE;

	const { destroy, chain } = collectExplosionTargets(
		cx,
		cy,
		cz,
		radius,
		(x, y, z) => getBlockByWorldCoords(x, y, z),
	);

	// Chains first so neighboring TNT pops on a short fuse instead of
	// vanishing. Without an igniter (e.g. remote replay) just clear it.
	let chained = 0;
	const igniter = options.chainIgniter ?? null;
	if (igniter) {
		for (const target of chain) {
			igniter(target.x, target.y, target.z);
			chained++;
		}
	} else {
		for (const target of chain) {
			destroy.push(target);
		}
	}

	const notify = getOnBlockBroken();
	for (const target of destroy) {
		deleteBlock(target.x, target.y, target.z);
		notify?.(target.x, target.y, target.z, target.blockId);
	}

	// --- FX ---
	const packedLight = getLightByWorldCoords(cx, cy, cz);
	playExplosion(cx, cy, cz, radius, packedLight);

	const burstCount = Math.min(options.maxBurstBlocks ?? 12, destroy.length);
	for (let i = 0; i < burstCount; i++) {
		const target = destroy[Math.floor((i * destroy.length) / burstCount)];
		const pos: Vec3 = {
			x: target.x + 0.5,
			y: target.y + 0.5,
			z: target.z + 0.5,
		};
		play(pos, target.blockId, packedLight);
		playDebris(
			target.x + 0.5,
			target.y + 0.5,
			target.z + 0.5,
			target.blockId,
			packedLight,
		);
	}
	playLandingDust(cx, cy, cz, radius * 3);
	playExplosionSound(1);
	flashScreen(1);

	// --- Player damage / knockback / shake ---
	// Defaults to the local player so chained blasts (which carry no explicit
	// player) still hurt. Pass explicit null for FX-only detonation.
	const player =
		options.player === undefined ? Map1.mainPlayer : options.player;
	if (player) {
		const p = player.position;
		const dx = p.x - cx;
		const dy = p.y + 0.9 - cy; // aim at the torso, not the feet
		const dz = p.z - cz;
		const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
		const falloff = explosionFalloff(dist, radius);

		if (falloff > 0) {
			if (player.stats.gamemode !== Gamemodes.Creative) {
				player.stats.takeDamage(Math.floor(falloff * maxDamage));
			}
			const inv = 1 / Math.max(dist, 0.5);
			const force = falloff * 11;
			player.playerVehicle.addExplosionImpulse(
				dx * inv * force,
				(dy * inv * 0.6 + 0.65) * force,
				dz * inv * force,
			);
			player.playerCamera.addTrauma(Math.min(1, falloff + 0.25));
		} else {
			// Distant rumble: faint shake out to 2.5x radius.
			const rumble = explosionFalloff(dist, radius * 2.5);
			if (rumble > 0) {
				player.playerCamera.addTrauma(rumble * 0.4);
			}
		}
	}

	// --- Mob damage (no knockback API on mobs yet — damage only, v1) ---
	const registry = Map1.mobRegistry;
	if (registry) {
		for (const mob of registry.getAllMobs()) {
			if (mob.isDisposed) continue;
			const mp = mob.position;
			const dx = mp.x - cx;
			const dy = mp.y - cy;
			const dz = mp.z - cz;
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
			const falloff = explosionFalloff(dist, radius);
			if (falloff > 0) {
				mob.takeDamage(Math.floor(falloff * maxDamage), {
					x: cx,
					y: cy,
					z: cz,
				});
			}
		}
	}

	return { destroyed: destroy.length, chained };
}
