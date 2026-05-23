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
	lod4HorizontalRadius: number;
	lod5HorizontalRadius: number;
	lod6HorizontalRadius: number;
	lod7HorizontalRadius: number;
	lod0VerticalRadius: number;
	lod1VerticalRadius: number;
	lod2VerticalRadius: number;
	lod3VerticalRadius: number;
	lod4VerticalRadius: number;
	lod5VerticalRadius: number;
	lod6VerticalRadius: number;
	lod7VerticalRadius: number;
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

export class Lod4ChunkCreationRule implements ChunkLodCreationRule {
	public readonly lodLevel = 4;
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

export class Lod5ChunkCreationRule implements ChunkLodCreationRule {
	public readonly lodLevel = 5;
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

export class Lod6ChunkCreationRule implements ChunkLodCreationRule {
	public readonly lodLevel = 6;
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

export class Lod7ChunkCreationRule implements ChunkLodCreationRule {
	public readonly lodLevel = 7;
	public readonly allowsChunkCreation = false;

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
	): ChunkLodRuleSet {
		const radii: ChunkLodRadii = {
			lod0HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_0_OFFSET,
			lod1HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_1_OFFSET,
			lod2HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_2_OFFSET,
			lod3HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_3_OFFSET,
			lod4HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_4_OFFSET,
			lod5HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_5_OFFSET,
			lod6HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_6_OFFSET,
			lod7HorizontalRadius: renderDistance + SETTING_PARAMS.LOD_7_OFFSET,
			lod0VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_0_OFFSET,
			lod1VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_1_OFFSET,
			lod2VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_2_OFFSET,
			lod3VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_3_OFFSET,
			lod4VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_4_OFFSET,
			lod5VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_5_OFFSET,
			lod6VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_6_OFFSET,
			lod7VerticalRadius: verticalRadius + SETTING_PARAMS.LOD_VERTICAL_7_OFFSET,
		};

		return new ChunkLodRuleSet(radii, [
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
			new Lod4ChunkCreationRule(
				radii.lod4HorizontalRadius,
				radii.lod4VerticalRadius,
			),
			new Lod5ChunkCreationRule(
				radii.lod5HorizontalRadius,
				radii.lod5VerticalRadius,
			),
			new Lod6ChunkCreationRule(
				radii.lod6HorizontalRadius,
				radii.lod6VerticalRadius,
			),
			new Lod7ChunkCreationRule(
				radii.lod7HorizontalRadius,
				radii.lod7VerticalRadius,
			),
			new DistantOnlyChunkCreationRule(7),
		]);
	}

	public constructor(
		public readonly radii: ChunkLodRadii,
		private readonly rules: ChunkLodCreationRule[],
	) {}

	private resolveWithDistance(distance: ChunkLodDistance): ChunkLodDecision {
		for (const rule of this.rules) {
			if (rule.matches(distance)) {
				return {
					...distance,
					lodLevel: rule.lodLevel,
					allowsChunkCreation: rule.allowsChunkCreation,
				};
			}
		}

		const fallback = this.rules[this.rules.length - 1];
		return {
			...distance,
			lodLevel: fallback?.lodLevel ?? 4,
			allowsChunkCreation: fallback?.allowsChunkCreation ?? false,
		};
	}

	private measureDistance(
		target: ChunkLodCoordinates,
		player: ChunkLodCoordinates,
	): ChunkLodDistance {
		return {
			horizontalDist: Math.max(
				Math.abs(target.chunkX - player.chunkX),
				Math.abs(target.chunkZ - player.chunkZ),
			),
			verticalDist: Math.abs(target.chunkY - player.chunkY),
		};
	}

	public resolveWithHysteresis(
		target: ChunkLodCoordinates,
		player: ChunkLodCoordinates,
		previousLod: number | null | undefined,
	): ChunkLodDecision {
		const distance = this.measureDistance(target, player);
		const baseDecision = this.resolve(target, player);

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

		const withinPreviousBandWithBuffer = (() => {
			switch (previousLod) {
				case 0:
					return (
						distance.horizontalDist <=
							this.radii.lod0HorizontalRadius + horizontalLeaveBuffer &&
						distance.verticalDist <=
							this.radii.lod0VerticalRadius + verticalLeaveBuffer
					);
				case 1:
					return (
						distance.horizontalDist <=
							this.radii.lod1HorizontalRadius + horizontalLeaveBuffer &&
						distance.verticalDist <=
							this.radii.lod1VerticalRadius + verticalLeaveBuffer
					);
				case 2:
					return (
						distance.horizontalDist <=
							this.radii.lod2HorizontalRadius + horizontalLeaveBuffer &&
						distance.verticalDist <=
							this.radii.lod2VerticalRadius + verticalLeaveBuffer
					);
				case 3:
					return (
						distance.horizontalDist <=
							this.radii.lod3HorizontalRadius + horizontalLeaveBuffer &&
						distance.verticalDist <=
							this.radii.lod3VerticalRadius + verticalLeaveBuffer
					);
				case 4:
					return (
						distance.horizontalDist <=
							this.radii.lod4HorizontalRadius + horizontalLeaveBuffer &&
						distance.verticalDist <=
							this.radii.lod4VerticalRadius + verticalLeaveBuffer
					);
				case 5:
					return (
						distance.horizontalDist <=
							this.radii.lod5HorizontalRadius + horizontalLeaveBuffer &&
						distance.verticalDist <=
							this.radii.lod5VerticalRadius + verticalLeaveBuffer
					);
				case 6:
					return (
						distance.horizontalDist <=
							this.radii.lod6HorizontalRadius + horizontalLeaveBuffer &&
						distance.verticalDist <=
							this.radii.lod6VerticalRadius + verticalLeaveBuffer
					);
				case 7:
					return (
						distance.horizontalDist <=
							this.radii.lod7HorizontalRadius + horizontalLeaveBuffer &&
						distance.verticalDist <=
							this.radii.lod7VerticalRadius + verticalLeaveBuffer
					);
				default:
					return false;
			}
		})();

		if (withinPreviousBandWithBuffer && previousLod < baseDecision.lodLevel) {
			return {
				...distance,
				lodLevel: previousLod,
				allowsChunkCreation: previousBandAllowsCreation,
			};
		}

		return baseDecision;
	}
}
