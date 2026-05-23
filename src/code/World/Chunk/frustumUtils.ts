import { type FreeCamera, Matrix, Plane } from "@babylonjs/core";
import { Chunk } from "./Chunk";

const _scratchPlanes: Plane[] = [];
const _vpMatrix = new Matrix();

export function extractFrustumPlanes(
	camera: FreeCamera,
	out: Plane[] = _scratchPlanes,
): Plane[] {
	const scene = camera.getScene();
	if (!scene) return out;
	const cameraMatrix = camera.getViewMatrix();
	const projectionMatrix = camera.getProjectionMatrix();

	projectionMatrix.multiplyToRef(cameraMatrix, _vpMatrix);

	const m = _vpMatrix.m;

	out.length = 6;

	if (!out[0]) out[0] = new Plane(0, 0, 0, 0);
	out[1] = out[1] ?? new Plane(0, 0, 0, 0);
	out[2] = out[2] ?? new Plane(0, 0, 0, 0);
	out[3] = out[3] ?? new Plane(0, 0, 0, 0);
	out[4] = out[4] ?? new Plane(0, 0, 0, 0);
	out[5] = out[5] ?? new Plane(0, 0, 0, 0);

	out[0].normal.x = m[3] + m[0];
	out[0].normal.y = m[7] + m[4];
	out[0].normal.z = m[11] + m[8];
	out[0].d = m[15] + m[12];
	out[0].normalize();

	out[1].normal.x = m[3] - m[0];
	out[1].normal.y = m[7] - m[4];
	out[1].normal.z = m[11] - m[8];
	out[1].d = m[15] - m[12];
	out[1].normalize();

	out[2].normal.x = m[3] + m[1];
	out[2].normal.y = m[7] + m[5];
	out[2].normal.z = m[11] + m[9];
	out[2].d = m[15] + m[13];
	out[2].normalize();

	out[3].normal.x = m[3] - m[1];
	out[3].normal.y = m[7] - m[5];
	out[3].normal.z = m[11] - m[9];
	out[3].d = m[15] - m[13];
	out[3].normalize();

	out[4].normal.x = m[3] + m[2];
	out[4].normal.y = m[7] + m[6];
	out[4].normal.z = m[11] + m[10];
	out[4].d = m[15] + m[14];
	out[4].normalize();

	out[5].normal.x = m[3] - m[2];
	out[5].normal.y = m[7] - m[6];
	out[5].normal.z = m[11] - m[10];
	out[5].d = m[15] - m[14];
	out[5].normalize();

	return out;
}

export function chunkAabbInFrustum(chunk: Chunk, planes: Plane[]): boolean {
	const size = Chunk.SIZE;
	const minX = chunk.chunkX * size;
	const minY = chunk.chunkY * size;
	const minZ = chunk.chunkZ * size;
	const maxX = minX + size;
	const maxY = minY + size;
	const maxZ = minZ + size;

	for (let i = 0; i < 6; i++) {
		const plane = planes[i]!;
		const nx = plane.normal.x;
		const ny = plane.normal.y;
		const nz = plane.normal.z;
		const d = plane.d;

		const pX = nx >= 0 ? maxX : minX;
		const pY = ny >= 0 ? maxY : minY;
		const pZ = nz >= 0 ? maxZ : minZ;
		const distP = nx * pX + ny * pY + nz * pZ + d;

		if (distP < 0) return false;
	}

	return true;
}
