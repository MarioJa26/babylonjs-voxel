export type BoxLike = { min: readonly number[]; max: readonly number[] };

export type BoxesGeometry = {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
};

export function buildBoxesGeometry(
	boxes: readonly BoxLike[],
	inflation: number,
): BoxesGeometry {
	const boxCount = boxes.length;
	const positions = new Float32Array(boxCount * 24 * 3);
	const normals = new Float32Array(boxCount * 24 * 3);
	const indices = new Uint32Array(boxCount * 36);

	const h = inflation * 0.5;

	let p = 0;
	let n = 0;
	let ii = 0;
	let base = 0;

	function writeVertex(
		x: number,
		y: number,
		z: number,
		nx: number,
		ny: number,
		nz: number,
	): void {
		positions[p++] = x;
		positions[p++] = y;
		positions[p++] = z;

		normals[n++] = nx;
		normals[n++] = ny;
		normals[n++] = nz;
	}

	function writeFace(
		nx: number,
		ny: number,
		nz: number,
		x0: number,
		y0: number,
		z0: number,
		x1: number,
		y1: number,
		z1: number,
		x2: number,
		y2: number,
		z2: number,
		x3: number,
		y3: number,
		z3: number,
	): void {
		const b = base;

		writeVertex(x0, y0, z0, nx, ny, nz);
		writeVertex(x1, y1, z1, nx, ny, nz);
		writeVertex(x2, y2, z2, nx, ny, nz);
		writeVertex(x3, y3, z3, nx, ny, nz);

		indices[ii++] = b;
		indices[ii++] = b + 1;
		indices[ii++] = b + 2;
		indices[ii++] = b;
		indices[ii++] = b + 2;
		indices[ii++] = b + 3;

		base += 4;
	}

	for (let b = 0; b < boxCount; b++) {
		const box = boxes[b];

		const x0 = box.min[0] - h;
		const y0 = box.min[1] - h;
		const z0 = box.min[2] - h;
		const x1 = box.max[0] + h;
		const y1 = box.max[1] + h;
		const z1 = box.max[2] + h;

		writeFace(1, 0, 0, x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0);

		writeFace(-1, 0, 0, x0, y0, z1, x0, y0, z0, x0, y1, z0, x0, y1, z1);

		writeFace(0, 1, 0, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1);

		writeFace(0, -1, 0, x0, y0, z1, x1, y0, z1, x1, y0, z0, x0, y0, z0);

		writeFace(0, 0, 1, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);

		writeFace(0, 0, -1, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
	}

	return { positions, normals, indices };
}
