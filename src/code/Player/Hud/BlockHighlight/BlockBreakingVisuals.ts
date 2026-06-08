import {
	Color3,
	Mesh,
	MeshBuilder,
	type Scene,
	StandardMaterial,
} from "@babylonjs/core";
import { SETTING_PARAMS } from "@/code/World/SETTINGS_PARAMS";
import { getTransformedShapeBoxes } from "@/code/World/Shape/BlockShapeTransforms";
import type { BoatBlockHitContext } from "./BreakingBlockHandler";

let scene: Scene | null = null;
let crackingMesh: Mesh | null = null;
let crackMaterials: StandardMaterial[] = [];
let crackingShapeKey = -1;
let crackingLastStage = -1;
let crackingLastBlockX = 0;
let crackingLastBlockY = 0;
let crackingLastBlockZ = 0;
let crackingLastContext: unknown = null;

export function initializeBlockBreakingVisuals(targetScene: Scene): void {
	if (scene === targetScene && crackingMesh) {
		return;
	}

	disposeBlockBreakingVisuals();

	scene = targetScene;
	crackingMesh = createUnitCrackingMesh();
	crackingMesh.isPickable = false;
	crackingMesh.isVisible = false;
	crackingMesh.renderingGroupId = 1;

	for (let i = 0; i < 10; i++) {
		const mat = new StandardMaterial(`crackMat${i}`, scene);
		mat.diffuseColor = new Color3(
			SETTING_PARAMS.HIGHLIGHT_COLOR[0],
			SETTING_PARAMS.HIGHLIGHT_COLOR[1],
			SETTING_PARAMS.HIGHLIGHT_COLOR[2],
		);
		mat.alpha = 0.1 + (i / 9) * 0.6;
		mat.backFaceCulling = false;
		mat.disableLighting = true;
		mat.zOffset = -1;
		crackMaterials.push(mat);
	}
}

export function disposeBlockBreakingVisuals(): void {
	crackingMesh?.dispose();
	crackingMesh = null;

	for (const mat of crackMaterials) {
		mat.dispose();
	}

	crackMaterials = [];
	crackingShapeKey = -1;
	crackingLastStage = -1;
	scene = null;
}

export function updateCrackingState(
	block: { x: number; y: number; z: number } | null,
	progress: number,
	blockId?: number,
	blockState = 0,
	dynamicContext: unknown = null,
): void {
	if (!block || progress <= 0) {
		if (crackingMesh) {
			crackingMesh.isVisible = false;
			crackingMesh.parent = null;
		}
		return;
	}

	if (!crackingMesh) return;

	if (typeof blockId === "number") {
		ensureCrackingShape(blockId, blockState);
	}

	crackingMesh.isVisible = true;
	if (
		block.x !== crackingLastBlockX ||
		block.y !== crackingLastBlockY ||
		block.z !== crackingLastBlockZ ||
		dynamicContext !== crackingLastContext
	) {
		applyCrackingTransform(block, dynamicContext);
		crackingLastBlockX = block.x;
		crackingLastBlockY = block.y;
		crackingLastBlockZ = block.z;
		crackingLastContext = dynamicContext;
	}

	const stage = Math.min(9, Math.floor(progress * 10));
	if (stage !== crackingLastStage) {
		crackingLastStage = stage;
		if (crackMaterials[stage]) {
			crackingMesh.material = crackMaterials[stage];
		}
	}
}

function createUnitCrackingMesh(): Mesh {
	if (!scene) {
		throw new Error("BlockBreakingVisuals not initialized");
	}

	const mesh = MeshBuilder.CreateBox(
		"crackingMeshUnitCube",
		{ size: 1.04 },
		scene,
	);
	mesh.position.set(0.5, 0.5, 0.5);
	bakeLocalOffset(mesh);
	return mesh;
}

function bakeLocalOffset(mesh: Mesh): void {
	mesh.bakeCurrentTransformIntoVertices();
	mesh.position.set(0, 0, 0);
}

const inflation = 0.04;
const parts: Mesh[] = [];
function buildCrackingMeshForBlock(blockId: number, blockState: number): Mesh {
	if (!scene) {
		throw new Error("BlockBreakingVisuals not initialized");
	}

	let index = 0;
	parts.length = 0;

	for (const box of getTransformedShapeBoxes(blockId, blockState)) {
		const width = box.max[0] - box.min[0];
		const height = box.max[1] - box.min[1];
		const depth = box.max[2] - box.min[2];
		if (width <= 0 || height <= 0 || depth <= 0) continue;

		const part = MeshBuilder.CreateBox(
			`crackingMeshPart_${index++}`,
			{
				width: width + inflation,
				height: height + inflation,
				depth: depth + inflation,
			},
			scene,
		);

		part.position.set(
			(box.min[0] + box.max[0]) * 0.5,
			(box.min[1] + box.max[1]) * 0.5,
			(box.min[2] + box.max[2]) * 0.5,
		);

		bakeLocalOffset(part);
		parts.push(part);
	}

	if (parts.length === 0) {
		return createUnitCrackingMesh();
	}

	if (parts.length === 1) {
		return parts[0];
	}

	const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
	if (!merged || !(merged instanceof Mesh)) {
		const fallback = parts[0];
		for (let i = 1; i < parts.length; i++) {
			parts[i].dispose();
		}
		return fallback;
	}

	return merged;
}

function ensureCrackingShape(blockId: number, blockState: number): void {
	const shapeKey = (blockId << 6) | blockState;
	if (shapeKey === crackingShapeKey) return;
	if (!crackingMesh) return;

	const oldMesh = crackingMesh;
	const newMesh = buildCrackingMeshForBlock(blockId, blockState);

	newMesh.position.copyFrom(oldMesh.position);
	newMesh.parent = oldMesh.parent;
	newMesh.isPickable = false;

	newMesh.isVisible = oldMesh.isVisible;
	newMesh.renderingGroupId = oldMesh.renderingGroupId;
	newMesh.material = oldMesh.material;

	crackingMesh = newMesh;
	crackingShapeKey = shapeKey;

	oldMesh?.dispose();
}

function applyCrackingTransform(
	block: { x: number; y: number; z: number },
	dynamicContext: unknown,
): void {
	if (!crackingMesh) return;

	const boatContext = asBoatBlockContext(dynamicContext);
	if (boatContext) {
		const center = boatContext.boatChunk.center;

		crackingMesh.parent = boatContext.boatChunk.visualRoot;
		crackingMesh.position.set(
			boatContext.localX - center.x,
			boatContext.localY - center.y,
			boatContext.localZ - center.z,
		);
		return;
	}

	crackingMesh.parent = null;
	crackingMesh.position.set(
		Math.floor(block.x),
		Math.floor(block.y),
		Math.floor(block.z),
	);
}

function asBoatBlockContext(context: unknown): BoatBlockHitContext | null {
	if (!context || typeof context !== "object") {
		return null;
	}

	const value = context as Partial<BoatBlockHitContext>;
	if (value.kind !== "boatChunk") {
		return null;
	}

	if (
		typeof value.localX !== "number" ||
		typeof value.localY !== "number" ||
		typeof value.localZ !== "number"
	) {
		return null;
	}

	const boatChunk = value.boatChunk as
		| BoatBlockHitContext["boatChunk"]
		| undefined;

	if (!boatChunk?.visualRoot || !boatChunk?.center) {
		return null;
	}

	return {
		kind: "boatChunk",
		boatChunk,
		localX: value.localX,
		localY: value.localY,
		localZ: value.localZ,
	};
}
