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
  ): ChunkLodRuleSet {
    const radii: ChunkLodRadii = {
      lod0HorizontalRadius: renderDistance,
      lod1HorizontalRadius: renderDistance + 6,
      lod2HorizontalRadius: renderDistance + 12,
      lod3HorizontalRadius: renderDistance + 18,
      lod0VerticalRadius: verticalRadius,
      lod1VerticalRadius: verticalRadius + 2,
      lod2VerticalRadius: verticalRadius + 4,
      lod3VerticalRadius: verticalRadius + 6,
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
      new DistantOnlyChunkCreationRule(4),
    ]);
  }

  public constructor(
    public readonly radii: ChunkLodRadii,
    private readonly rules: ChunkLodCreationRule[],
  ) {}

  public resolve(
    target: ChunkLodCoordinates,
    player: ChunkLodCoordinates,
  ): ChunkLodDecision {
    const distance = this.measureDistance(target, player);

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
}
