import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";

/**
 * Highest per-chunk LOD band index. LOD4+ use geometric downsampling in the
 * mesher (lodStep = 1 << (lod - 3)). Anything beyond this distance falls to
 * DistantOnly (no chunk creation).
 */
export const MAX_CHUNK_LOD = 5;
/** lodLevel assigned by the fallback rule when no band matches. */
export const DISTANT_LOD_LEVEL = MAX_CHUNK_LOD + 1;

export type ChunkLodCoordinates = {
	chunkX: number;
	chunkY: number;
	chunkZ: number;
};

export type ChunkLodRadii = {
	lod0HorizontalRadius: number;
	lod1HorizontalRadius: number;
	lod2HorizontalRadius: number;
	lod3HorizontalRadius: number;
	lod4HorizontalRadius: number;
	lod5HorizontalRadius: number;
	lod0VerticalRadius: number;
	lod1VerticalRadius: number;
	lod2VerticalRadius: number;
	lod3VerticalRadius: number;
	lod4VerticalRadius: number;
	lod5VerticalRadius: number;
};

export type ChunkLodDistance = {
	horizontalDist: number;
	verticalDist: number;
};

export type ChunkLodDecision = ChunkLodDistance & {
	lodLevel: number;
	allowsChunkCreation: boolean;
};

export interface ChunkLodCreationRule {
	readonly lodLevel: number;
	readonly allowsChunkCreation: boolean;
	matches(distance: ChunkLodDistance): boolean;
}

// PERF: reused across resolveWithDistance calls (single-threaded) so we never
// allocate a ChunkLodDistance object for rule matching.
const _scratchDistance: ChunkLodDistance = {
	horizontalDist: 0,
	verticalDist: 0,
};

// PERF: single reused decision object returned by resolveWithDistance /
// resolveWithHysteresis. Callers consume it synchronously (never retain the
// reference), so a shared scratch removes the per-call object allocation.
const _scratchDecision: ChunkLodDecision = {
	horizontalDist: 0,
	verticalDist: 0,
	lodLevel: 0,
	allowsChunkCreation: false,
};

export class Lod0ChunkCreationRule implements ChunkLodCreationRule {
	public readonly lodLevel = 0;
	public readonly allowsChunkCreation = true;

	public constructor(
		private readonly horizontalRadius: number,
		private readonly verticalRadius: number,
	) {}

	public matches(distance: ChunkLodDistance): boolean {
		return (
			distance.horizontalDist <= this.horizontalRadius &&
			distance.verticalDist <= this.verticalRadius
		);
	}
}

/**
 * Generic square band rule shared by every non-zero LOD ring. Matches when
 * the chunk lies within BOTH radii of the player; rules are evaluated
 * innermost-first, so each band only receives chunks its inner neighbors
 * rejected.
 */
export class BandChunkCreationRule implements ChunkLodCreationRule {
	public readonly allowsChunkCreation = true;

	public constructor(
		public readonly lodLevel: number,
		private readonly horizontalRadius: number,
		private readonly verticalRadius: number,
	) {}

	public matches(distance: ChunkLodDistance): boolean {
		return (
			distance.horizontalDist <= this.horizontalRadius &&
			distance.verticalDist <= this.verticalRadius
		);
	}
}

export class DistantOnlyChunkCreationRule implements ChunkLodCreationRule {
	public readonly allowsChunkCreation = false;

	public constructor(public readonly lodLevel = DISTANT_LOD_LEVEL) {}

	public matches(_distance: ChunkLodDistance): boolean {
		return true;
	}
}

export class ChunkLodRuleSet {
	public static fromRenderRadii(
		renderDistance: number,
		verticalRadius: number,
		revision: number = 0,
	): ChunkLodRuleSet {
		const horizontalOffsets = [
			SETTING_PARAMS.LOD_0_OFFSET,
			SETTING_PARAMS.LOD_1_OFFSET,
			SETTING_PARAMS.LOD_2_OFFSET,
			SETTING_PARAMS.LOD_3_OFFSET,
			SETTING_PARAMS.LOD_4_OFFSET,
			SETTING_PARAMS.LOD_5_OFFSET,
		];

		const verticalOffsets = [
			SETTING_PARAMS.LOD_VERTICAL_0_OFFSET,
			SETTING_PARAMS.LOD_VERTICAL_1_OFFSET,
			SETTING_PARAMS.LOD_VERTICAL_2_OFFSET,
			SETTING_PARAMS.LOD_VERTICAL_3_OFFSET,
			SETTING_PARAMS.LOD_VERTICAL_4_OFFSET,
			SETTING_PARAMS.LOD_VERTICAL_5_OFFSET,
		];

		const horizontalRadii = horizontalOffsets.map(
			(offset) => renderDistance + offset,
		);

		const verticalRadii = verticalOffsets.map(
			(offset) => verticalRadius + offset,
		);

		const radii: ChunkLodRadii = {
			lod0HorizontalRadius: horizontalRadii[0],
			lod1HorizontalRadius: horizontalRadii[1],
			lod2HorizontalRadius: horizontalRadii[2],
			lod3HorizontalRadius: horizontalRadii[3],
			lod4HorizontalRadius: horizontalRadii[4],
			lod5HorizontalRadius: horizontalRadii[5],
			lod0VerticalRadius: verticalRadii[0],
			lod1VerticalRadius: verticalRadii[1],
			lod2VerticalRadius: verticalRadii[2],
			lod3VerticalRadius: verticalRadii[3],
			lod4VerticalRadius: verticalRadii[4],
			lod5VerticalRadius: verticalRadii[5],
		};

		const rules: ChunkLodCreationRule[] = [
			new Lod0ChunkCreationRule(horizontalRadii[0], verticalRadii[0]),
		];

		for (let lod = 1; lod <= MAX_CHUNK_LOD; lod++) {
			rules.push(
				new BandChunkCreationRule(
					lod,
					horizontalRadii[lod],
					verticalRadii[lod],
				),
			);
		}

		rules.push(new DistantOnlyChunkCreationRule(DISTANT_LOD_LEVEL));

		return new ChunkLodRuleSet(
			radii,
			rules,
			horizontalRadii,
			verticalRadii,
			revision,
		);
	}

	public constructor(
		public readonly radii: ChunkLodRadii,
		private readonly rules: ChunkLodCreationRule[],
		/** Per-band horizontal radii indexed by lodLevel (0..MAX_CHUNK_LOD). */
		private readonly horizontalRadiiArr: number[],
		/** Per-band vertical radii indexed by lodLevel (0..MAX_CHUNK_LOD). */
		private readonly verticalRadiiArr: number[],
		/**
		 * Monotonic counter bumped by callers (typically ChunkStreamingController)
		 * when the rule set is rebuilt. Consumers that cache decisions derived
		 * from this rule set can use `revision` to invalidate their cache.
		 */
		public readonly revision: number = 0,
	) {}

	/** Widest chunk-creating horizontal band of this rule set. */
	public maxHorizontalRadius(): number {
		return Math.max(...this.horizontalRadiiArr);
	}

	/** Widest chunk-creating vertical band of this rule set. */
	public maxVerticalRadius(): number {
		return Math.max(...this.verticalRadiiArr);
	}

	public horizontalRadiusFor(lod: number): number {
		return this.horizontalRadiiArr[lod] ?? Number.MAX_SAFE_INTEGER;
	}

	public verticalRadiusFor(lod: number): number {
		return this.verticalRadiiArr[lod] ?? Number.MAX_SAFE_INTEGER;
	}

	// PERF: reused across resolveWithDistance calls (single-threaded) so we
	// never allocate a ChunkLodDistance object for rule matching.
	private resolveWithDistance(
		horizontalDist: number,
		verticalDist: number,
	): ChunkLodDecision {
		_scratchDistance.horizontalDist = horizontalDist;
		_scratchDistance.verticalDist = verticalDist;
		for (const rule of this.rules) {
			if (rule.matches(_scratchDistance)) {
				_scratchDecision.horizontalDist = horizontalDist;
				_scratchDecision.verticalDist = verticalDist;
				_scratchDecision.lodLevel = rule.lodLevel;
				_scratchDecision.allowsChunkCreation = rule.allowsChunkCreation;
				return _scratchDecision;
			}
		}

		const fallback = this.rules[this.rules.length - 1];
		_scratchDecision.horizontalDist = horizontalDist;
		_scratchDecision.verticalDist = verticalDist;
		_scratchDecision.lodLevel = fallback?.lodLevel ?? DISTANT_LOD_LEVEL;
		_scratchDecision.allowsChunkCreation =
			fallback?.allowsChunkCreation ?? false;
		return _scratchDecision;
	}

	public resolve(
		target: ChunkLodCoordinates,
		player: ChunkLodCoordinates,
	): ChunkLodDecision {
		const horizontalDist = Math.max(
			Math.abs(target.chunkX - player.chunkX),
			Math.abs(target.chunkZ - player.chunkZ),
		);
		const verticalDist = Math.abs(target.chunkY - player.chunkY);
		const d = this.resolveWithDistance(horizontalDist, verticalDist);
		// Cold path — return a fresh object so external retainers are safe.
		return {
			horizontalDist: d.horizontalDist,
			verticalDist: d.verticalDist,
			lodLevel: d.lodLevel,
			allowsChunkCreation: d.allowsChunkCreation,
		};
	}

	public resolveWithHysteresis(
		targetX: number,
		targetY: number,
		targetZ: number,
		playerX: number,
		playerY: number,
		playerZ: number,
		previousLod: number | null | undefined,
	): ChunkLodDecision {
		return this._resolveWithHysteresis(
			Math.max(Math.abs(targetX - playerX), Math.abs(targetZ - playerZ)),
			Math.abs(targetY - playerY),
			previousLod,
		);
	}

	/**
	 * Like resolveWithHysteresis but accepts precomputed distances — avoids
	 * redundant abs/max computation when the caller already has hDist/vDist
	 * (e.g. enqueueLoadedChunksForRefresh which computes both for the
	 * LOD-boundary pre-check before resolving).
	 */
	public resolveWithHysteresisFromDistance(
		horizontalDist: number,
		verticalDist: number,
		previousLod: number | null | undefined,
	): ChunkLodDecision {
		return this._resolveWithHysteresis(
			horizontalDist,
			verticalDist,
			previousLod,
		);
	}

	private _resolveWithHysteresis(
		horizontalDist: number,
		verticalDist: number,
		previousLod: number | null | undefined,
	): ChunkLodDecision {
		const baseDecision = this.resolveWithDistance(horizontalDist, verticalDist);

		if (previousLod === null || previousLod === undefined) {
			return baseDecision;
		}

		// Keep outer bands deterministic.
		// LOD2 <-> LOD3 hysteresis causes visible "mixed ring" patches where
		// neighboring chunks linger at different outer LODs.
		if (previousLod >= 2 && baseDecision.lodLevel >= 2) {
			return baseDecision;
		}

		if (
			previousLod < 0 ||
			previousLod > MAX_CHUNK_LOD ||
			!Number.isInteger(previousLod)
		) {
			return baseDecision;
		}

		const horizontalLeaveBuffer = 1;
		const verticalLeaveBuffer = 1;

		const withinPreviousBandWithBuffer =
			horizontalDist <=
				this.horizontalRadiiArr[previousLod] + horizontalLeaveBuffer &&
			verticalDist <= this.verticalRadiiArr[previousLod] + verticalLeaveBuffer;

		if (withinPreviousBandWithBuffer && previousLod < baseDecision.lodLevel) {
			baseDecision.lodLevel = previousLod;
			baseDecision.allowsChunkCreation = true;
			return baseDecision;
		}

		return baseDecision;
	}
}
