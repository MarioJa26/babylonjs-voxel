import {
	Color4,
	ParticleSystem,
	type Scene,
	type Texture,
	Vector3,
} from "@babylonjs/core";
import { GLOBAL_VALUES } from "../World/GLOBAL_VALUES";
import { BlockTextures } from "../World/Texture/BlockTextures";
import { FaceName } from "../World/Texture/FaceName";
import { TextureAtlasFactory } from "../World/Texture/TextureAtlasFactory";

let particleSystem: ParticleSystem;
const _scratchColor1 = new Color4(0, 0, 0, 0);
const _scratchColor2 = new Color4(0, 0, 0, 0);
const _scratchColorDead = new Color4(0, 0, 0, 0);

export function play(
	scene: Scene,
	position: Vector3,
	blockId: number,
	packedLight: number,
) {
	if (!particleSystem) {
		init(scene);
	}

	particleSystem.emitter = position;

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

	const blockTex = BlockTextures[blockId];
	if (blockTex) {
		const uv =
			blockTex[FaceName.All] ||
			blockTex[FaceName.Side] ||
			blockTex[FaceName.Top] ||
			blockTex[FaceName.Bottom] ||
			Object.values(blockTex)[0];
		if (uv) {
			const row = TextureAtlasFactory.atlasSize - 1 - uv[1];
			const cellId = row * TextureAtlasFactory.atlasSize + uv[0];
			particleSystem.startSpriteCellID = cellId;
			particleSystem.endSpriteCellID = cellId;
			particleSystem.spriteCellChangeSpeed = 0;
		}
		particleSystem.color1 = _scratchColor1;
		_scratchColor1.copyFromFloats(finalR, finalG, finalB, 1);
		particleSystem.color2 = _scratchColor2;
		_scratchColor2.copyFromFloats(finalR, finalG, finalB, 1);
		particleSystem.colorDead = _scratchColorDead;
		_scratchColorDead.copyFromFloats(
			finalR * 0.9,
			finalG * 0.9,
			finalB * 0.9,
			0,
		);
	} else {
		const defaultCell =
			(TextureAtlasFactory.atlasSize - 1) * TextureAtlasFactory.atlasSize;
		particleSystem.startSpriteCellID = defaultCell;
		particleSystem.endSpriteCellID = defaultCell;
		particleSystem.color1 = _scratchColor1;
		_scratchColor1.copyFromFloats(finalR, finalG, finalB, 1);
		particleSystem.color2 = _scratchColor2;
		_scratchColor2.copyFromFloats(finalR, finalG, finalB, 1);
		particleSystem.colorDead = _scratchColorDead;
		_scratchColorDead.copyFromFloats(
			finalR * 0.9,
			finalG * 0.9,
			finalB * 0.9,
			0,
		);
	}

	particleSystem.manualEmitCount = 64;
	particleSystem.start();
}

function init(scene: Scene) {
	particleSystem = new ParticleSystem("blockBreakParticles", 1200, scene);

	const atlas = TextureAtlasFactory.getDiffuse();
	if (atlas) {
		particleSystem.particleTexture = atlas;
		particleSystem.isAnimationSheetEnabled = true;
		particleSystem.spriteCellWidth = TextureAtlasFactory.tileSize;
		particleSystem.spriteCellHeight = TextureAtlasFactory.tileSize;
	}

	particleSystem.minSize = 0.05;
	particleSystem.maxSize = 0.1;
	particleSystem.minLifeTime = 0.5;
	particleSystem.maxLifeTime = 1.0;
	particleSystem.emitRate = 1000;
	particleSystem.gravity = new Vector3(0, -10, 0);
	particleSystem.direction1 = new Vector3(-1, 1, -1);
	particleSystem.direction2 = new Vector3(1, 2, 1);
	particleSystem.minEmitPower = 0;
	particleSystem.maxEmitPower = 1;
	particleSystem.updateSpeed = 0.0166;
	particleSystem.renderingGroupId = 1;
	particleSystem.blendMode = ParticleSystem.BLENDMODE_STANDARD;
	particleSystem.billboardMode = ParticleSystem.BILLBOARDMODE_ALL;
}

export function setAtlasTexture(texture: Texture) {
	if (particleSystem) {
		particleSystem.particleTexture = texture;
		particleSystem.isAnimationSheetEnabled = true;
		particleSystem.spriteCellWidth = TextureAtlasFactory.tileSize;
		particleSystem.spriteCellHeight = TextureAtlasFactory.tileSize;
	}
}
