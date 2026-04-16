import {
	Color4,
	ParticleSystem,
	type Scene,
	type Texture,
	Vector3,
} from "@babylonjs/core";
import { GLOBAL_VALUES } from "../World/GlobalValues";
import { BlockTextures } from "../World/Texture/BlockTextures";
import { TextureAtlasFactory } from "../World/Texture/TextureAtlasFactory";

export class BlockBreakParticles {
	private static particleSystem: ParticleSystem;

	public static play(
		scene: Scene,
		position: Vector3,
		blockId: number,
		packedLight: number,
	) {
		if (!BlockBreakParticles.particleSystem) {
			BlockBreakParticles.init(scene);
		}

		BlockBreakParticles.particleSystem.emitter = position;
		const lightTint = BlockBreakParticles.computeLightTint(packedLight);

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
				BlockBreakParticles.particleSystem.startSpriteCellID = cellId;
				BlockBreakParticles.particleSystem.endSpriteCellID = cellId;
				BlockBreakParticles.particleSystem.spriteCellChangeSpeed = 0;
			}
			BlockBreakParticles.particleSystem.color1 = new Color4(
				lightTint.r,
				lightTint.g,
				lightTint.b,
				1,
			);
			BlockBreakParticles.particleSystem.color2 = new Color4(
				lightTint.r,
				lightTint.g,
				lightTint.b,
				1,
			);
			BlockBreakParticles.particleSystem.colorDead = new Color4(
				lightTint.r * 0.9,
				lightTint.g * 0.9,
				lightTint.b * 0.9,
				0,
			);
		} else {
			// Fallback to a default cell (e.g. cobble at 0,0 -> row 15) if no texture found
			const defaultCell =
				(TextureAtlasFactory.atlasSize - 1) * TextureAtlasFactory.atlasSize;
			BlockBreakParticles.particleSystem.startSpriteCellID = defaultCell;
			BlockBreakParticles.particleSystem.endSpriteCellID = defaultCell;
			BlockBreakParticles.particleSystem.color1 = new Color4(
				lightTint.r,
				lightTint.g,
				lightTint.b,
				1,
			);
			BlockBreakParticles.particleSystem.color2 = new Color4(
				lightTint.r,
				lightTint.g,
				lightTint.b,
				1,
			);
			BlockBreakParticles.particleSystem.colorDead = new Color4(
				lightTint.r * 0.9,
				lightTint.g * 0.9,
				lightTint.b * 0.9,
				0,
			);
		}

		BlockBreakParticles.particleSystem.manualEmitCount = 64;
		BlockBreakParticles.particleSystem.start();
	}

	private static init(scene: Scene) {
		BlockBreakParticles.particleSystem = new ParticleSystem(
			"blockBreakParticles",
			12000,
			scene,
		);

		const atlas = TextureAtlasFactory.getDiffuse();
		if (atlas) {
			BlockBreakParticles.particleSystem.particleTexture = atlas;
			BlockBreakParticles.particleSystem.isAnimationSheetEnabled = true;
			BlockBreakParticles.particleSystem.spriteCellWidth =
				TextureAtlasFactory.tileSize;
			BlockBreakParticles.particleSystem.spriteCellHeight =
				TextureAtlasFactory.tileSize;
		}

		BlockBreakParticles.particleSystem.minSize = 0.05;
		BlockBreakParticles.particleSystem.maxSize = 0.1;
		BlockBreakParticles.particleSystem.minLifeTime = 0.5;
		BlockBreakParticles.particleSystem.maxLifeTime = 1.0;
		BlockBreakParticles.particleSystem.emitRate = 1000;
		BlockBreakParticles.particleSystem.gravity = new Vector3(0, -10, 0);
		BlockBreakParticles.particleSystem.direction1 = new Vector3(-1, 1, -1);
		BlockBreakParticles.particleSystem.direction2 = new Vector3(1, 2, 1);
		BlockBreakParticles.particleSystem.minEmitPower = 0;
		BlockBreakParticles.particleSystem.maxEmitPower = 1;
		BlockBreakParticles.particleSystem.updateSpeed = 0.0166;
		BlockBreakParticles.particleSystem.renderingGroupId = 1;
		BlockBreakParticles.particleSystem.blendMode =
			ParticleSystem.BLENDMODE_STANDARD;
		BlockBreakParticles.particleSystem.billboardMode =
			ParticleSystem.BILLBOARDMODE_ALL;
	}

	public static setAtlasTexture(texture: Texture) {
		if (BlockBreakParticles.particleSystem) {
			BlockBreakParticles.particleSystem.particleTexture = texture;
			BlockBreakParticles.particleSystem.isAnimationSheetEnabled = true;
			BlockBreakParticles.particleSystem.spriteCellWidth =
				TextureAtlasFactory.tileSize;
			BlockBreakParticles.particleSystem.spriteCellHeight =
				TextureAtlasFactory.tileSize;
		}
	}

	private static computeLightTint(packedLight: number): {
		r: number;
		g: number;
		b: number;
	} {
		const skyLight = ((packedLight >> 4) & 0xf) / 15;
		const blockLight = (packedLight & 0xf) / 15;

		const sunElevation = -GLOBAL_VALUES.skyLightDirection.y + 0.1;
		const sunLightIntensity = Math.min(1.0, Math.max(0.1, sunElevation * 4.0));
		const skyScale = sunLightIntensity + 0.3;

		const skyR = skyLight * 0.8 * skyScale;
		const skyG = skyLight * 0.8 * skyScale;
		const skyB = skyLight * 0.8 * skyScale;

		const blockR = blockLight * 0.9;
		const blockG = blockLight * 0.6;
		const blockB = blockLight * 0.2;

		const finalR = Math.min(1, Math.max(0.2, skyR + blockR));
		const finalG = Math.min(1, Math.max(0.2, skyG + blockG));
		const finalB = Math.min(1, Math.max(0.2, skyB + blockB));

		return { r: finalR, g: finalG, b: finalB };
	}
}
