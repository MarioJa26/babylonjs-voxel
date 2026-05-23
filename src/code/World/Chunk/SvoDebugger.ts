import type { Mesh, Scene } from "@babylonjs/core";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Chunk } from "./Chunk";

export type SvoDebugOptions = {
	maxDepth?: number;
	showLeavesOnly?: boolean;
	colorByDepth?: boolean;
	skipAir?: boolean;
};

export class SvoDebugger {
	private meshes: Mesh[] = [];
	private visible = false;
	private debuggedChunks = new Set<bigint>();

	get isVisible(): boolean {
		return this.visible;
	}

	toggle(chunk: Chunk, scene: Scene, _options?: SvoDebugOptions): void {
		if (this.visible) {
			this.dispose();
			return;
		}
		this._visualizeChunk(chunk, scene);
		this.visible = true;
	}

	toggleAll(scene: Scene, _options?: SvoDebugOptions): void {
		if (this.visible) {
			this.dispose();
			return;
		}

		let count = 0;
		for (const chunk of Chunk.loadedChunkIndex.all()) {
			if (chunk.isLoaded && chunk.hasVoxelData && chunk.block_array) {
				this._visualizeChunk(chunk, scene);
				count++;
			}
		}

		console.log(`[SVO Debug] Visualizing ${count} loaded chunks`);
		this.visible = true;
	}

	toggleNear(scene: Scene, wx: number, wy: number, wz: number, worldRadius: number, _options?: SvoDebugOptions): void {
		if (this.visible) {
			this.dispose();
			return;
		}

		let count = 0;
		let totalQueried = 0;

		console.log(`[SVO Debug] Querying chunks around (${wx.toFixed(0)}, ${wy.toFixed(0)}, ${wz.toFixed(0)}) worldRadius=${worldRadius}`);

		for (const chunk of Chunk.loadedChunkIndex.query(wx, wy, wz, worldRadius, worldRadius)) {
			totalQueried++;
			const dx = (chunk.chunkX * Chunk.SIZE + Chunk.SIZE / 2) - wx;
			const dy = (chunk.chunkY * Chunk.SIZE + Chunk.SIZE / 2) - wy;
			const dz = (chunk.chunkZ * Chunk.SIZE + Chunk.SIZE / 2) - wz;
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (dist > worldRadius) continue;

			console.log(`[SVO Debug] candidate chunk(${chunk.chunkX},${chunk.chunkY},${chunk.chunkZ}): loaded=${chunk.isLoaded} hasVoxel=${chunk.hasVoxelData} svo=${chunk.block_array ? `Uint32Array[${chunk.block_array.length}]` : "null"} isUniform=${chunk.isUniform} uniformId=${chunk.uniformBlockId}`);

			if (chunk.isLoaded && chunk.hasVoxelData && chunk.block_array) {
				this._visualizeChunk(chunk, scene);
				count++;
			}
		}

		console.log(`[SVO Debug] Queried ${totalQueried} chunks, visualizing ${count}`);

		if (count === 0 && totalQueried === 0) {
			console.warn("[SVO Debug] No chunks found in index. Creating test box to verify rendering...");
			const testBox = MeshBuilder.CreateBox("svo_test_box", { size: 5 }, scene);
			testBox.position.set(wx, wy + 10, wz);
			testBox.renderingGroupId = 1;
			const testMat = new StandardMaterial("svo_test_mat", scene);
			testMat.wireframe = true;
			testMat.diffuseColor = Color3.Red();
			testMat.emissiveColor = new Color3(1, 0, 0);
			testMat.alpha = 1;
			testMat.disableLighting = true;
			testBox.material = testMat;
			this.meshes.push(testBox);
		}

		this.visible = true;
	}

	private _visualizeChunk(chunk: Chunk, scene: Scene): void {
		const svo = chunk.block_array;
		if (!svo || !chunk.isLoaded) return;

		this.debuggedChunks.add(chunk.id);

		const chunkWorldX = chunk.chunkX * Chunk.SIZE;
		const chunkWorldY = chunk.chunkY * Chunk.SIZE;
		const chunkWorldZ = chunk.chunkZ * Chunk.SIZE;

		const box = MeshBuilder.CreateBox(
			`svo_debug_${chunk.id}`,
			{ size: 1 },
			scene,
		);
		box.scaling.setAll(Chunk.SIZE);
		box.position.set(
			chunkWorldX + Chunk.SIZE / 2,
			chunkWorldY + Chunk.SIZE / 2,
			chunkWorldZ + Chunk.SIZE / 2,
		);
		box.renderingGroupId = 1;

		const mat = new StandardMaterial(`svo_mat_${chunk.id}`, scene);
		mat.wireframe = true;
		mat.diffuseColor = new Color3(1, 0, 0);
		mat.emissiveColor = new Color3(0.5, 0, 0);
		mat.alpha = 0.8;
		mat.disableLighting = true;
		box.material = mat;

		this.meshes.push(box);
		console.log(`[SVO Debug] chunk(${chunk.chunkX},${chunk.chunkY},${chunk.chunkZ}): drew boundary box at (${box.position.x}, ${box.position.y}, ${box.position.z})`);
	}

	dispose(): void {
		for (const mesh of this.meshes) {
			mesh.material?.dispose();
			mesh.dispose();
		}
		this.meshes = [];
		this.debuggedChunks.clear();
		this.visible = false;
	}
}
