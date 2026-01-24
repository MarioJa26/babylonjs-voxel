import {
  Color4,
  ParticleSystem,
  Texture,
  Vector3,
  Scene,
} from "@babylonjs/core";
import { TextureAtlasFactory } from "../World/Texture/TextureAtlasFactory";
import { BlockTextures } from "../World/Texture/BlockTextures";

export class BlockBreakParticles {
  private static particleSystem: ParticleSystem;

  public static play(scene: Scene, position: Vector3, blockId: number) {
    if (!this.particleSystem) {
      this.init(scene);
    }

    this.particleSystem.emitter = position;

    const blockTex = BlockTextures[blockId];
    if (blockTex) {
      const uv =
        blockTex.all ||
        blockTex.side ||
        blockTex.top ||
        blockTex.bottom ||
        Object.values(blockTex)[0];
      if (uv) {
        // Invert row index because ParticleSystem starts from top-left (V=1)
        // but our atlas with invertY=true puts row 0 at bottom-left (V=0)
        const row = TextureAtlasFactory.atlasSize - 1 - uv[1];
        const cellId = row * TextureAtlasFactory.atlasSize + uv[0];
        this.particleSystem.startSpriteCellID = cellId;
        this.particleSystem.endSpriteCellID = cellId;
        this.particleSystem.spriteCellChangeSpeed = 0;
      }
      this.particleSystem.color1 = new Color4(1, 1, 1, 1);
      this.particleSystem.color2 = new Color4(1, 1, 1, 1);
      this.particleSystem.colorDead = new Color4(0.9, 1, 0.9, 0);
    } else {
      // Fallback to a default cell (e.g. cobble at 0,0 -> row 15) if no texture found
      const defaultCell =
        (TextureAtlasFactory.atlasSize - 1) * TextureAtlasFactory.atlasSize;
      this.particleSystem.startSpriteCellID = defaultCell;
      this.particleSystem.endSpriteCellID = defaultCell;
    }

    this.particleSystem.manualEmitCount = 64;
    this.particleSystem.start();
  }

  private static init(scene: Scene) {
    this.particleSystem = new ParticleSystem(
      "blockBreakParticles",
      12000,
      scene,
    );

    const atlas = TextureAtlasFactory.getDiffuse();
    if (atlas) {
      this.particleSystem.particleTexture = atlas;
      this.particleSystem.isAnimationSheetEnabled = true;
      this.particleSystem.spriteCellWidth = TextureAtlasFactory.tileSize;
      this.particleSystem.spriteCellHeight = TextureAtlasFactory.tileSize;
    }

    this.particleSystem.minSize = 0.05;
    this.particleSystem.maxSize = 0.1;
    this.particleSystem.minLifeTime = 0.5;
    this.particleSystem.maxLifeTime = 1.0;
    this.particleSystem.emitRate = 1000;
    this.particleSystem.gravity = new Vector3(0, -10, 0);
    this.particleSystem.direction1 = new Vector3(-1, 1, -1);
    this.particleSystem.direction2 = new Vector3(1, 2, 1);
    this.particleSystem.minEmitPower = 0;
    this.particleSystem.maxEmitPower = 1;
    this.particleSystem.updateSpeed = 0.0166;
    this.particleSystem.renderingGroupId = 1;
    this.particleSystem.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    this.particleSystem.billboardMode = ParticleSystem.BILLBOARDMODE_ALL;
  }

  public static setAtlasTexture(texture: Texture) {
    if (this.particleSystem) {
      this.particleSystem.particleTexture = texture;
      this.particleSystem.isAnimationSheetEnabled = true;
      this.particleSystem.spriteCellWidth = TextureAtlasFactory.tileSize;
      this.particleSystem.spriteCellHeight = TextureAtlasFactory.tileSize;
    }
  }
}
