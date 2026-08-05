import { SETTING_PARAMS } from "../../SETTINGS_PARAMS";

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
	lod0VerticalRadius: number;
	lod1VerticalRadius: number;
	lod2VerticalRadius: number;
	lod3VerticalRadius: number;
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

export class Lod1ChunkCreationRule implements ChunkLodCreationRule {
	public readonly lodLevel = 1;
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

export class Lod2ChunkCreationRule implements ChunkLodCreationRule {
	public readonly lodLevel = 2;
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

export class Lod3ChunkCreationRule implements ChunkLodCreationRule {
	public readonly lodLevel = 3;
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

export class DistantOnlyChunkCreationRule implements ChunkLodCreationRule {
	public readonly allowsChunkCreation = false;

	public constructor(public readonly lodLevel = 4) {}

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
		const radii: ChunkLodRadii = {
			lod0HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_0_OFFSET,
			lod1HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_1_OFFSET,
			lod2HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_2_OFFSET,
			lod3HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_3_OFFSET,
			lod0VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_0_OFFSET,
			lod1VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_1_OFFSET,
			lod2VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_2_OFFSET,
			lod3VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_3_OFFSET,
		};

		return new ChunkLodRuleSet(
			radii,
			[
				new Lod0ChunkCreationRule(
					radii.lod0HorizontalRadius,
					radii.lod0VerticalRadius,
				),
				new Lod1ChunkCreationRule(
					radii.lod1HorizontalRadius,
					radii.lod1VerticalRadius,
				),
				new Lod2ChunkCreationRule(
					radii.lod2HorizontalRadius,
					radii.lod2VerticalRadius,
				),
				new Lod3ChunkCreationRule(
					radii.lod3HorizontalRadius,
					radii.lod3VerticalRadius,
				),
				new DistantOnlyChunkCreationRule(4),
			],
			revision,
		);
	}

	public constructor(
		public readonly radii: ChunkLodRadii,
		private readonly rules: ChunkLodCreationRule[],
		/**
		 * Monotonic counter bumped by callers (typically ChunkStreamingController)
		 * when the rule set is rebuilt. Consumers that cache decisions derived
		 * from this rule set can use `revision` to invalidate their cache.
		 */
		public readonly revision: number = 0,
	) {}

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
		_scratchDecision.lodLevel = fallback?.lodLevel ?? 4;
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

		const horizontalLeaveBuffer = 1;
		const verticalLeaveBuffer = 1;

		const previousBandAllowsCreation = previousLod >= 0 && previousLod <= 3;

		let withinPreviousBandWithBuffer = false;
		switch (previousLod) {
			case 0:
				withinPreviousBandWithBuffer =
					horizontalDist <=
						this.radii.lod0HorizontalRadius + horizontalLeaveBuffer &&
					verticalDist <= this.radii.lod0VerticalRadius + verticalLeaveBuffer;
				break;
			case 1:
				withinPreviousBandWithBuffer =
					horizontalDist <=
						this.radii.lod1HorizontalRadius + horizontalLeaveBuffer &&
					verticalDist <= this.radii.lod1VerticalRadius + verticalLeaveBuffer;
				break;
			case 2:
				withinPreviousBandWithBuffer =
					horizontalDist <=
						this.radii.lod2HorizontalRadius + horizontalLeaveBuffer &&
					verticalDist <= this.radii.lod2VerticalRadius + verticalLeaveBuffer;
				break;
			case 3:
				withinPreviousBandWithBuffer =
					horizontalDist <=
						this.radii.lod3HorizontalRadius + horizontalLeaveBuffer &&
					verticalDist <= this.radii.lod3VerticalRadius + verticalLeaveBuffer;
				break;
		}

		if (withinPreviousBandWithBuffer && previousLod < baseDecision.lodLevel) {
			baseDecision.lodLevel = previousLod;
			baseDecision.allowsChunkCreation = previousBandAllowsCreation;
			return baseDecision;
		}

		return baseDecision;
	}
}
