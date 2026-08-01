import { addVec3InPlace, type Vec3, type Vec4, vec3 } from "@babylonjs/lite";

/**
 * Pure-TypeScript math + utility library used by the Lite port.
 *
 * `@babylonjs/core` is not a dependency of this project. The handful of
 * math/utility types the gameplay code relied on (Vector2, Color3/4,
 * Quaternion, Matrix, Observable, Tools, Scalar) are re-implemented here.
 *
 * `Vec3` (from `@babylonjs/lite`) is a plain `{ x, y, z }` data interface
 * with NO methods — there is no `Vector3` class. All vector math here is
 * free functions operating on that plain shape, following lite's own
 * ToRef (write into `result`, zero-alloc) / InPlace (mutate `target`)
 * convention. Prefer the ToRef/InPlace variants in hot paths.
 *
 * Runtime-only: no rendering, no engine dependency.
 */

export class Vector2 {
	constructor(
		public x: number = 0,
		public y: number = 0,
	) {}

	static Zero(): Vector2 {
		return new Vector2(0, 0);
	}
	static One(): Vector2 {
		return new Vector2(1, 1);
	}
	static FromArray(arr: ArrayLike<number>, offset = 0): Vector2 {
		return new Vector2(arr[offset], arr[offset + 1]);
	}
	static Lerp(start: Vector2, end: Vector2, amount: number): Vector2 {
		return new Vector2(
			start.x + (end.x - start.x) * amount,
			start.y + (end.y - start.y) * amount,
		);
	}
	static Dot(left: Vector2, right: Vector2): number {
		return left.x * right.x + left.y * right.y;
	}
	static DistanceSquared(a: Vector2, b: Vector2): number {
		const dx = a.x - b.x;
		const dy = a.y - b.y;
		return dx * dx + dy * dy;
	}
	static Distance(a: Vector2, b: Vector2): number {
		return Math.sqrt(Vector2.DistanceSquared(a, b));
	}

	clone(): Vector2 {
		return new Vector2(this.x, this.y);
	}
	copyFrom(src: Vector2): Vector2 {
		this.x = src.x;
		this.y = src.y;
		return this;
	}
	copyFromFloats(x: number, y: number): Vector2 {
		this.x = x;
		this.y = y;
		return this;
	}
	set(x: number, y: number): Vector2 {
		this.x = x;
		this.y = y;
		return this;
	}
	add(other: Vector2): Vector2 {
		return new Vector2(this.x + other.x, this.y + other.y);
	}
	addToRef(other: Vector2, result: Vector2): Vector2 {
		result.x = this.x + other.x;
		result.y = this.y + other.y;
		return result;
	}
	addInPlace(other: Vector2): Vector2 {
		this.x += other.x;
		this.y += other.y;
		return this;
	}
	subtract(other: Vector2): Vector2 {
		return new Vector2(this.x - other.x, this.y - other.y);
	}
	subtractToRef(other: Vector2, result: Vector2): Vector2 {
		result.x = this.x - other.x;
		result.y = this.y - other.y;
		return result;
	}
	subtractInPlace(other: Vector2): Vector2 {
		this.x -= other.x;
		this.y -= other.y;
		return this;
	}
	scale(scale: number): Vector2 {
		return new Vector2(this.x * scale, this.y * scale);
	}
	scaleToRef(scale: number, result: Vector2): Vector2 {
		result.x = this.x * scale;
		result.y = this.y * scale;
		return result;
	}
	scaleInPlace(scale: number): Vector2 {
		this.x *= scale;
		this.y *= scale;
		return this;
	}
	length(): number {
		return Math.sqrt(this.x * this.x + this.y * this.y);
	}
	lengthSquared(): number {
		return this.x * this.x + this.y * this.y;
	}
	normalize(): Vector2 {
		const len = this.length();
		if (len > 1e-8) {
			this.x /= len;
			this.y /= len;
		}
		return this;
	}
	dot(other: Vector2): number {
		return Vector2.Dot(this, other);
	}
	equals(other: Vector2): boolean {
		return this.x === other.x && this.y === other.y;
	}
	toArray(arr: number[] | Float32Array, offset = 0): number[] | Float32Array {
		arr[offset] = this.x;
		arr[offset + 1] = this.y;
		return arr;
	}
	asArray(): [number, number] {
		return [this.x, this.y];
	}
}

// ── Vec3 free functions ──────────────────────────────────────────────────
// Plain-data operations on lite's `Vec3` ({ x, y, z }, no methods). ToRef
// variants write into `result` (zero-alloc); InPlace variants mutate
// `target`; bare variants allocate and return a new Vec3 via `vec3()`.

export function vec3Zero(): Vec3 {
	return vec3(0, 0, 0);
}
export function vec3One(): Vec3 {
	return vec3(1, 1, 1);
}
export function vec3Up(): Vec3 {
	return vec3(0, 1, 0);
}
export function vec3Down(): Vec3 {
	return vec3(0, -1, 0);
}
export function vec3Forward(): Vec3 {
	return vec3(0, 0, 1);
}
export function vec3Backward(): Vec3 {
	return vec3(0, 0, -1);
}
export function vec3Right(): Vec3 {
	return vec3(1, 0, 0);
}
export function vec3Left(): Vec3 {
	return vec3(-1, 0, 0);
}
export function vec3Center(): Vec3 {
	return vec3(0.5, 0.5, 0.5);
}
export function vec3AxisX(): Vec3 {
	return vec3(1, 0, 0);
}
export function vec3AxisY(): Vec3 {
	return vec3(0, 1, 0);
}
export function vec3AxisZ(): Vec3 {
	return vec3(0, 0, 1);
}

export function copyVec3(out: Vec3, src: Vec3): Vec3 {
	out.x = src.x;
	out.y = src.y;
	out.z = src.z;
	return out;
}
export function setVec3(out: Vec3, x: number, y: number, z: number): Vec3 {
	out.x = x;
	out.y = y;
	out.z = z;
	return out;
}

export function vec3FromArray(arr: ArrayLike<number>, offset = 0): Vec3 {
	return vec3(arr[offset], arr[offset + 1], arr[offset + 2]);
}
export function vec3FromFloatArrayToRef(
	arr: Float32Array,
	offset: number,
	result: Vec3,
): Vec3 {
	return setVec3(result, arr[offset], arr[offset + 1], arr[offset + 2]);
}

export function lerpVec3(start: Vec3, end: Vec3, amount: number): Vec3 {
	return vec3(
		start.x + (end.x - start.x) * amount,
		start.y + (end.y - start.y) * amount,
		start.z + (end.z - start.z) * amount,
	);
}
export function lerpVec3ToRef(
	start: Vec3,
	end: Vec3,
	amount: number,
	result: Vec3,
): Vec3 {
	return setVec3(
		result,
		start.x + (end.x - start.x) * amount,
		start.y + (end.y - start.y) * amount,
		start.z + (end.z - start.z) * amount,
	);
}

export function subtractVec3(a: Vec3, b: Vec3): Vec3 {
	return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function subtractVec3ToRef(a: Vec3, b: Vec3, result: Vec3): Vec3 {
	return setVec3(result, a.x - b.x, a.y - b.y, a.z - b.z);
}
export function subtractVec3InPlace(target: Vec3, b: Vec3): Vec3 {
	target.x -= b.x;
	target.y -= b.y;
	target.z -= b.z;
	return target;
}

export function negateVec3(v: Vec3): Vec3 {
	return vec3(-v.x, -v.y, -v.z);
}
export function negateVec3InPlace(target: Vec3): Vec3 {
	target.x = -target.x;
	target.y = -target.y;
	target.z = -target.z;
	return target;
}

export function lengthVec3(v: Vec3): number {
	return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
export function lengthSqVec3(v: Vec3): number {
	return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function normalizeVec3(v: Vec3): Vec3 {
	return normalizeVec3ToRef(v, vec3(0, 0, 0));
}
export function normalizeVec3ToRef(v: Vec3, result: Vec3): Vec3 {
	const len = lengthVec3(v);
	if (len < 1e-8) return setVec3(result, 0, 0, 0);
	return setVec3(result, v.x / len, v.y / len, v.z / len);
}
export function normalizeVec3InPlace(target: Vec3): Vec3 {
	return normalizeVec3ToRef(target, target);
}

export function dotVec3(a: Vec3, b: Vec3): number {
	return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function crossVec3(a: Vec3, b: Vec3): Vec3 {
	return crossVec3ToRef(a, b, vec3(0, 0, 0));
}
export function crossVec3ToRef(a: Vec3, b: Vec3, result: Vec3): Vec3 {
	const x = a.y * b.z - a.z * b.y;
	const y = a.z * b.x - a.x * b.z;
	const z = a.x * b.y - a.y * b.x;
	return setVec3(result, x, y, z);
}

export function distanceSqVec3(a: Vec3, b: Vec3): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	const dz = a.z - b.z;
	return dx * dx + dy * dy + dz * dz;
}
export function distanceVec3(a: Vec3, b: Vec3): number {
	return Math.sqrt(distanceSqVec3(a, b));
}

export function minimizeVec3(a: Vec3, b: Vec3): Vec3 {
	return vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
}
export function maximizeVec3(a: Vec3, b: Vec3): Vec3 {
	return vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
}
export function minimizeVec3InPlace(target: Vec3, other: Vec3): Vec3 {
	target.x = Math.min(target.x, other.x);
	target.y = Math.min(target.y, other.y);
	target.z = Math.min(target.z, other.z);
	return target;
}
export function maximizeVec3InPlace(target: Vec3, other: Vec3): Vec3 {
	target.x = Math.max(target.x, other.x);
	target.y = Math.max(target.y, other.y);
	target.z = Math.max(target.z, other.z);
	return target;
}

export function equalsVec3(a: Vec3, b: Vec3): boolean {
	return a.x === b.x && a.y === b.y && a.z === b.z;
}
export function equalsVec3WithEpsilon(
	a: Vec3,
	b: Vec3,
	epsilon = 1e-6,
): boolean {
	return (
		Math.abs(a.x - b.x) <= epsilon &&
		Math.abs(a.y - b.y) <= epsilon &&
		Math.abs(a.z - b.z) <= epsilon
	);
}

export function multiplyVec3(a: Vec3, b: Vec3): Vec3 {
	return vec3(a.x * b.x, a.y * b.y, a.z * b.z);
}
export function multiplyVec3ToRef(a: Vec3, b: Vec3, result: Vec3): Vec3 {
	return setVec3(result, a.x * b.x, a.y * b.y, a.z * b.z);
}

export function floorVec3(v: Vec3): Vec3 {
	return vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
}
export function fractVec3(v: Vec3): Vec3 {
	return vec3(
		v.x - Math.floor(v.x),
		v.y - Math.floor(v.y),
		v.z - Math.floor(v.z),
	);
}
export function absVec3(v: Vec3): Vec3 {
	return vec3(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
}

export function toArrayVec3(
	v: Vec3,
	arr: number[] | Float32Array,
	offset = 0,
): number[] | Float32Array {
	arr[offset] = v.x;
	arr[offset + 1] = v.y;
	arr[offset + 2] = v.z;
	return arr;
}
export function asArrayVec3(v: Vec3): [number, number, number] {
	return [v.x, v.y, v.z];
}

export function transformCoordinatesVec3(
	vector: Vec3,
	transformation: Matrix,
): Vec3 {
	return transformCoordinatesVec3ToRef(vector, transformation, vec3(0, 0, 0));
}
export function transformCoordinatesVec3ToRef(
	vector: Vec3,
	transformation: Matrix,
	result: Vec3,
): Vec3 {
	const m = transformation.m;
	const x = vector.x;
	const y = vector.y;
	const z = vector.z;
	const w = x * m[3] + y * m[7] + z * m[11] + m[15] || 1.0;
	return setVec3(
		result,
		(x * m[0] + y * m[4] + z * m[8] + m[12]) / w,
		(x * m[1] + y * m[5] + z * m[9] + m[13]) / w,
		(x * m[2] + y * m[6] + z * m[10] + m[14]) / w,
	);
}
export function transformNormalVec3(
	vector: Vec3,
	transformation: Matrix,
): Vec3 {
	return transformNormalVec3ToRef(vector, transformation, vec3(0, 0, 0));
}
export function transformNormalVec3ToRef(
	vector: Vec3,
	transformation: Matrix,
	result: Vec3,
): Vec3 {
	const m = transformation.m;
	const x = vector.x;
	const y = vector.y;
	const z = vector.z;
	return setVec3(
		result,
		x * m[0] + y * m[4] + z * m[8],
		x * m[1] + y * m[5] + z * m[9],
		x * m[2] + y * m[6] + z * m[10],
	);
}

export function rotationFromAxisVec3(
	axis1: Vec3,
	axis2: Vec3,
	axis3: Vec3,
): Quaternion {
	return Quaternion.RotationQuaternionFromAxis(axis1, axis2, axis3);
}

export function catmullRomVec3(
	value1: Vec3,
	value2: Vec3,
	value3: Vec3,
	value4: Vec3,
	amount: number,
): Vec3 {
	const squared = amount * amount;
	const cubed = squared * amount;
	return vec3(
		0.5 *
			(2 * value2.x +
				(-value1.x + value3.x) * amount +
				(2 * value1.x - 5 * value2.x + 4 * value3.x - value4.x) * squared +
				(-value1.x + 3 * value2.x - 3 * value3.x + value4.x) * cubed),
		0.5 *
			(2 * value2.y +
				(-value1.y + value3.y) * amount +
				(2 * value1.y - 5 * value2.y + 4 * value3.y - value4.y) * squared +
				(-value1.y + 3 * value2.y - 3 * value3.y + value4.y) * cubed),
		0.5 *
			(2 * value2.z +
				(-value1.z + value3.z) * amount +
				(2 * value1.z - 5 * value2.z + 4 * value3.z - value4.z) * squared +
				(-value1.z + 3 * value2.z - 3 * value3.z + value4.z) * cubed),
	);
}
export function hermiteVec3(
	value1: Vec3,
	tangent1: Vec3,
	value2: Vec3,
	tangent2: Vec3,
	amount: number,
): Vec3 {
	const squared = amount * amount;
	const cubed = squared * amount;
	const a = 2 * cubed - 3 * squared + 1;
	const b = -2 * cubed + 3 * squared;
	const c = cubed - 2 * squared + amount;
	const d = cubed - squared;
	return vec3(
		a * value1.x + b * value2.x + c * tangent1.x + d * tangent2.x,
		a * value1.y + b * value2.y + c * tangent1.y + d * tangent2.y,
		a * value1.z + b * value2.z + c * tangent1.z + d * tangent2.z,
	);
}

/** Rotate `v` by quaternion `q`, writing the result into `result`. Safe to call
 *  with `result === v` (rotate in place). */
export function rotateVec3ByQuaternionToRef(
	q: Quaternion,
	v: Vec3,
	result: Vec3,
): Vec3 {
	const tx = 2 * (q.y * v.z - q.z * v.y);
	const ty = 2 * (q.z * v.x - q.x * v.z);
	const tz = 2 * (q.x * v.y - q.y * v.x);
	const rx = v.x + q.w * tx + (q.y * tz - q.z * ty);
	const ry = v.y + q.w * ty + (q.z * tx - q.x * tz);
	const rz = v.z + q.w * tz + (q.x * ty - q.y * tx);
	return setVec3(result, rx, ry, rz);
}
export function rotateVec3ByQuaternionAroundPointToRef(
	q: Quaternion,
	v: Vec3,
	point: Vec3,
	result: Vec3,
): Vec3 {
	subtractVec3ToRef(v, point, result);
	rotateVec3ByQuaternionToRef(q, result, result);
	return addVec3InPlace(result, point);
}

export function vec4(x: number, y: number, z: number, w: number): Vec4 {
	return { x, y, z, w };
}

export class Color3 {
	constructor(
		public r: number = 0,
		public g: number = 0,
		public b: number = 0,
	) {}

	static Black(): Color3 {
		return new Color3(0, 0, 0);
	}
	static White(): Color3 {
		return new Color3(1, 1, 1);
	}
	static Red(): Color3 {
		return new Color3(1, 0, 0);
	}
	static Green(): Color3 {
		return new Color3(0, 1, 0);
	}
	static Blue(): Color3 {
		return new Color3(0, 0, 1);
	}
	static Gray(): Color3 {
		return new Color3(0.5, 0.5, 0.5);
	}
	static Purple(): Color3 {
		return new Color3(0.5, 0, 0.5);
	}
	static Yellow(): Color3 {
		return new Color3(1, 1, 0);
	}
	static Teal(): Color3 {
		return new Color3(0, 1, 1);
	}
	static Magenta(): Color3 {
		return new Color3(1, 0, 1);
	}
	static FromArray(arr: ArrayLike<number>, offset = 0): Color3 {
		return new Color3(arr[offset], arr[offset + 1], arr[offset + 2]);
	}
	static FromInts(r: number, g: number, b: number): Color3 {
		return new Color3(r / 255, g / 255, b / 255);
	}
	static Lerp(left: Color3, right: Color3, amount: number): Color3 {
		return new Color3(
			left.r + (right.r - left.r) * amount,
			left.g + (right.g - left.g) * amount,
			left.b + (right.b - left.b) * amount,
		);
	}
	static Random(): Color3 {
		return new Color3(Math.random(), Math.random(), Math.random());
	}

	clone(): Color3 {
		return new Color3(this.r, this.g, this.b);
	}
	copyFrom(src: Color3): Color3 {
		this.r = src.r;
		this.g = src.g;
		this.b = src.b;
		return this;
	}
	copyFromFloats(r: number, g: number, b: number): Color3 {
		this.r = r;
		this.g = g;
		this.b = b;
		return this;
	}
	toArray(arr: number[] | Float32Array, offset = 0): number[] | Float32Array {
		arr[offset] = this.r;
		arr[offset + 1] = this.g;
		arr[offset + 2] = this.b;
		return arr;
	}
	toColor4(alpha = 1): Color4 {
		return new Color4(this.r, this.g, this.b, alpha);
	}
	scale(scale: number): Color3 {
		return new Color3(this.r * scale, this.g * scale, this.b * scale);
	}
	scaleToRef(scale: number, result: Color3): Color3 {
		result.r = this.r * scale;
		result.g = this.g * scale;
		result.b = this.b * scale;
		return result;
	}
	add(other: Color3): Color3 {
		return new Color3(this.r + other.r, this.g + other.g, this.b + other.b);
	}
	subtract(other: Color3): Color3 {
		return new Color3(this.r - other.r, this.g - other.g, this.b - other.b);
	}
	multiply(other: Color3): Color3 {
		return new Color3(this.r * other.r, this.g * other.g, this.b * other.b);
	}
	equals(other: Color3): boolean {
		return this.r === other.r && this.g === other.g && this.b === other.b;
	}
	toString(): string {
		return `Color3(${this.r}, ${this.g}, ${this.b})`;
	}
}

export class Color4 {
	constructor(
		public r: number = 0,
		public g: number = 0,
		public b: number = 0,
		public a: number = 1,
	) {}

	static Black(): Color4 {
		return new Color4(0, 0, 0, 1);
	}
	static White(): Color4 {
		return new Color4(1, 1, 1, 1);
	}
	static FromArray(arr: ArrayLike<number>, offset = 0): Color4 {
		return new Color4(
			arr[offset],
			arr[offset + 1],
			arr[offset + 2],
			arr[offset + 3],
		);
	}
	static Lerp(left: Color4, right: Color4, amount: number): Color4 {
		return new Color4(
			left.r + (right.r - left.r) * amount,
			left.g + (right.g - left.g) * amount,
			left.b + (right.b - left.b) * amount,
			left.a + (right.a - left.a) * amount,
		);
	}

	clone(): Color4 {
		return new Color4(this.r, this.g, this.b, this.a);
	}
	copyFrom(src: Color4): Color4 {
		this.r = src.r;
		this.g = src.g;
		this.b = src.b;
		this.a = src.a;
		return this;
	}
	copyFromFloats(r: number, g: number, b: number, a: number): Color4 {
		this.r = r;
		this.g = g;
		this.b = b;
		this.a = a;
		return this;
	}
	toArray(arr: number[] | Float32Array, offset = 0): number[] | Float32Array {
		arr[offset] = this.r;
		arr[offset + 1] = this.g;
		arr[offset + 2] = this.b;
		arr[offset + 3] = this.a;
		return arr;
	}
	asArray(): [number, number, number, number] {
		return [this.r, this.g, this.b, this.a];
	}
	toColor3(): Color3 {
		return new Color3(this.r, this.g, this.b);
	}
	scale(scale: number): Color4 {
		return new Color4(
			this.r * scale,
			this.g * scale,
			this.b * scale,
			this.a * scale,
		);
	}
	add(other: Color4): Color4 {
		return new Color4(
			this.r + other.r,
			this.g + other.g,
			this.b + other.b,
			this.a + other.a,
		);
	}
	multiply(other: Color4): Color4 {
		return new Color4(
			this.r * other.r,
			this.g * other.g,
			this.b * other.b,
			this.a * other.a,
		);
	}
	equals(other: Color4): boolean {
		return (
			this.r === other.r &&
			this.g === other.g &&
			this.b === other.b &&
			this.a === other.a
		);
	}
}

export class Quaternion {
	constructor(
		public x: number = 0,
		public y: number = 0,
		public z: number = 0,
		public w: number = 1,
	) {}

	static Identity(): Quaternion {
		return new Quaternion(0, 0, 0, 1);
	}
	static FromEulerAngles(x: number, y: number, z: number): Quaternion {
		return Quaternion.FromEulerAnglesToRef(x, y, z, new Quaternion());
	}
	static FromEulerAnglesToRef(
		x: number,
		y: number,
		z: number,
		result: Quaternion,
	): Quaternion {
		const halfX = x / 2;
		const halfY = y / 2;
		const halfZ = z / 2;
		const sx = Math.sin(halfX);
		const cx = Math.cos(halfX);
		const sy = Math.sin(halfY);
		const cy = Math.cos(halfY);
		const sz = Math.sin(halfZ);
		const cz = Math.cos(halfZ);
		result.x = sx * cy * cz + cx * sy * sz;
		result.y = cx * sy * cz - sx * cy * sz;
		result.z = cx * cy * sz + sx * sy * cz;
		result.w = cx * cy * cz - sx * sy * sz;
		return result;
	}
	static RotationAxis(axis: Vec3, angle: number): Quaternion {
		const half = angle / 2;
		const s = Math.sin(half);
		return new Quaternion(axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
	}
	static RotationYawPitchRoll(
		yaw: number,
		pitch: number,
		roll: number,
	): Quaternion {
		return Quaternion.FromEulerAngles(pitch, yaw, roll);
	}
	static RotationQuaternionFromAxis(
		axis1: Vec3,
		axis2: Vec3,
		axis3: Vec3,
	): Quaternion {
		const rot = Matrix.Identity();
		Matrix.FromXYZAxesToRef(axis1, axis2, axis3, rot);
		return Quaternion.FromRotationMatrix(rot);
	}
	static FromRotationMatrix(matrix: Matrix): Quaternion {
		return Quaternion.FromRotationMatrixToRef(matrix, new Quaternion());
	}
	static FromRotationMatrixToRef(
		matrix: Matrix,
		result: Quaternion,
	): Quaternion {
		const m = matrix.m;
		const trace = m[0] + m[5] + m[10];
		if (trace > 0) {
			const s = 0.5 / Math.sqrt(trace + 1.0);
			result.w = 0.25 / s;
			result.x = (m[6] - m[9]) * s;
			result.y = (m[8] - m[2]) * s;
			result.z = (m[1] - m[4]) * s;
		} else if (m[0] > m[5] && m[0] > m[10]) {
			const s = 2.0 * Math.sqrt(1.0 + m[0] - m[5] - m[10]);
			result.w = (m[6] - m[9]) / s;
			result.x = 0.25 * s;
			result.y = (m[1] + m[4]) / s;
			result.z = (m[8] + m[2]) / s;
		} else if (m[5] > m[10]) {
			const s = 2.0 * Math.sqrt(1.0 + m[5] - m[0] - m[10]);
			result.w = (m[8] - m[2]) / s;
			result.x = (m[1] + m[4]) / s;
			result.y = 0.25 * s;
			result.z = (m[6] + m[9]) / s;
		} else {
			const s = 2.0 * Math.sqrt(1.0 + m[10] - m[0] - m[5]);
			result.w = (m[1] - m[4]) / s;
			result.x = (m[8] + m[2]) / s;
			result.y = (m[6] + m[9]) / s;
			result.z = 0.25 * s;
		}
		return result;
	}
	static Slerp(
		left: Quaternion,
		right: Quaternion,
		amount: number,
	): Quaternion {
		let dot = Quaternion.Dot(left, right);
		const r = right.clone();
		if (dot < 0) {
			dot = -dot;
			r.x = -r.x;
			r.y = -r.y;
			r.z = -r.z;
			r.w = -r.w;
		}
		if (dot > 0.9995) {
			const result = new Quaternion(
				left.x + (r.x - left.x) * amount,
				left.y + (r.y - left.y) * amount,
				left.z + (r.z - left.z) * amount,
				left.w + (r.w - left.w) * amount,
			);
			return result.normalize();
		}
		const theta0 = Math.acos(dot);
		const theta = theta0 * amount;
		const sinTheta = Math.sin(theta);
		const sinTheta0 = Math.sin(theta0);
		const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
		const s1 = sinTheta / sinTheta0;
		return new Quaternion(
			left.x * s0 + r.x * s1,
			left.y * s0 + r.y * s1,
			left.z * s0 + r.z * s1,
			left.w * s0 + r.w * s1,
		);
	}
	static Dot(left: Quaternion, right: Quaternion): number {
		return (
			left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w
		);
	}
	static Normalize(q: Quaternion): Quaternion {
		return Quaternion.NormalizeToRef(q, new Quaternion());
	}
	static NormalizeToRef(q: Quaternion, result: Quaternion): Quaternion {
		const len = Math.sqrt(Quaternion.Dot(q, q));
		if (len < 1e-8) return result.copyFromFloats(0, 0, 0, 1);
		return result.copyFromFloats(q.x / len, q.y / len, q.z / len, q.w / len);
	}
	/** Rotate vector `v` by this quaternion, writing into `result`. */
	static RotateVectorToRef(q: Quaternion, v: Vec3, result: Vec3): Vec3 {
		return rotateVec3ByQuaternionToRef(q, v, result);
	}

	clone(): Quaternion {
		return new Quaternion(this.x, this.y, this.z, this.w);
	}
	copyFrom(src: Quaternion): Quaternion {
		this.x = src.x;
		this.y = src.y;
		this.z = src.z;
		this.w = src.w;
		return this;
	}
	copyFromFloats(x: number, y: number, z: number, w: number): Quaternion {
		this.x = x;
		this.y = y;
		this.z = z;
		this.w = w;
		return this;
	}
	set(x: number, y: number, z: number, w: number): Quaternion {
		this.x = x;
		this.y = y;
		this.z = z;
		this.w = w;
		return this;
	}
	toEulerAngles(): Vec3 {
		const m = this.toRotationMatrix();
		return m.toEulerAngles();
	}
	toRotationMatrix(): Matrix {
		return Quaternion.ToRotationMatrixToRef(this, new Matrix());
	}
	static ToRotationMatrixToRef(q: Quaternion, result: Matrix): Matrix {
		const x = q.x;
		const y = q.y;
		const z = q.z;
		const w = q.w;
		const xx = x + x;
		const yy = y + y;
		const zz = z + z;
		const wx = w * xx;
		const wy = w * yy;
		const wz = w * zz;
		const xx2 = x * xx;
		const xy = x * yy;
		const xz = x * zz;
		const yy2 = y * yy;
		const yz = y * zz;
		const zz2 = z * zz;
		result.m[0] = 1 - (yy2 + zz2);
		result.m[1] = xy + wz;
		result.m[2] = xz - wy;
		result.m[3] = 0;
		result.m[4] = xy - wz;
		result.m[5] = 1 - (xx2 + zz2);
		result.m[6] = yz + wx;
		result.m[7] = 0;
		result.m[8] = xz + wy;
		result.m[9] = yz - wx;
		result.m[10] = 1 - (xx2 + yy2);
		result.m[11] = 0;
		result.m[12] = 0;
		result.m[13] = 0;
		result.m[14] = 0;
		result.m[15] = 1;
		return result;
	}
	normalize(): Quaternion {
		return Quaternion.NormalizeToRef(this, this);
	}
	conjugateInPlace(): Quaternion {
		this.x = -this.x;
		this.y = -this.y;
		this.z = -this.z;
		return this;
	}
	conjugate(): Quaternion {
		return new Quaternion(-this.x, -this.y, -this.z, this.w);
	}
	invert(): Quaternion {
		return this.conjugate().normalize();
	}
	multiply(q: Quaternion): Quaternion {
		return Quaternion.MultiplyToRef(this, q, new Quaternion());
	}
	multiplyToRef(q: Quaternion, result: Quaternion): Quaternion {
		return Quaternion.MultiplyToRef(this, q, result);
	}
	static MultiplyToRef(
		left: Quaternion,
		right: Quaternion,
		result: Quaternion,
	): Quaternion {
		const lw = left.w;
		const lx = left.x;
		const ly = left.y;
		const lz = left.z;
		const rw = right.w;
		const rx = right.x;
		const ry = right.y;
		const rz = right.z;
		result.x = lx * rw + lw * rx + ly * rz - lz * ry;
		result.y = ly * rw + lw * ry + lz * rx - lx * rz;
		result.z = lz * rw + lw * rz + lx * ry - ly * rx;
		result.w = lw * rw - lx * rx - ly * ry - lz * rz;
		return result;
	}
	scale(scale: number): Quaternion {
		return new Quaternion(
			this.x * scale,
			this.y * scale,
			this.z * scale,
			this.w * scale,
		);
	}
	scaleToRef(scale: number, result: Quaternion): Quaternion {
		result.x = this.x * scale;
		result.y = this.y * scale;
		result.z = this.z * scale;
		result.w = this.w * scale;
		return result;
	}
	add(other: Quaternion): Quaternion {
		return new Quaternion(
			this.x + other.x,
			this.y + other.y,
			this.z + other.z,
			this.w + other.w,
		);
	}
	subtract(other: Quaternion): Quaternion {
		return new Quaternion(
			this.x - other.x,
			this.y - other.y,
			this.z - other.z,
			this.w - other.w,
		);
	}
	dot(other: Quaternion): number {
		return Quaternion.Dot(this, other);
	}
	length(): number {
		return Math.sqrt(Quaternion.Dot(this, this));
	}
	equals(other: Quaternion): boolean {
		return (
			this.x === other.x &&
			this.y === other.y &&
			this.z === other.z &&
			this.w === other.w
		);
	}
	toArray(arr: number[] | Float32Array, offset = 0): number[] | Float32Array {
		arr[offset] = this.x;
		arr[offset + 1] = this.y;
		arr[offset + 2] = this.z;
		arr[offset + 3] = this.w;
		return arr;
	}
}

export class Matrix {
	constructor(public m: number[] = Matrix.Identity().m.slice()) {}

	static Identity(): Matrix {
		return new Matrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	}
	static Zero(): Matrix {
		return new Matrix([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
	}
	static Translation(x: number, y: number, z: number): Matrix {
		const r = Matrix.Identity();
		r.m[12] = x;
		r.m[13] = y;
		r.m[14] = z;
		return r;
	}
	static Scaling(x: number, y: number, z: number): Matrix {
		return new Matrix([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
	}
	static RotationX(angle: number): Matrix {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		return new Matrix([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
	}
	static RotationY(angle: number): Matrix {
		return Matrix.RotationYToRef(angle, new Matrix());
	}
	static RotationYToRef(angle: number, result: Matrix): Matrix {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		const m = result.m;
		m[0] = c;
		m[1] = 0;
		m[2] = -s;
		m[3] = 0;
		m[4] = 0;
		m[5] = 1;
		m[6] = 0;
		m[7] = 0;
		m[8] = s;
		m[9] = 0;
		m[10] = c;
		m[11] = 0;
		m[12] = 0;
		m[13] = 0;
		m[14] = 0;
		m[15] = 1;
		return result;
	}
	static RotationZ(angle: number): Matrix {
		const c = Math.cos(angle);
		const s = Math.sin(angle);
		return new Matrix([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	}
	static RotationYawPitchRoll(
		yaw: number,
		pitch: number,
		roll: number,
	): Matrix {
		return Matrix.RotationY(yaw)
			.multiply(Matrix.RotationX(pitch))
			.multiply(Matrix.RotationZ(roll));
	}
	static FromEulerAngles(x: number, y: number, z: number): Matrix {
		return Quaternion.FromEulerAngles(x, y, z).toRotationMatrix();
	}
	static FromXYZAxesToRef(
		axis1: Vec3,
		axis2: Vec3,
		axis3: Vec3,
		result: Matrix,
	): Matrix {
		result.m[0] = axis1.x;
		result.m[1] = axis1.y;
		result.m[2] = axis1.z;
		result.m[3] = 0;
		result.m[4] = axis2.x;
		result.m[5] = axis2.y;
		result.m[6] = axis2.z;
		result.m[7] = 0;
		result.m[8] = axis3.x;
		result.m[9] = axis3.y;
		result.m[10] = axis3.z;
		result.m[11] = 0;
		result.m[12] = 0;
		result.m[13] = 0;
		result.m[14] = 0;
		result.m[15] = 1;
		return result;
	}
	static LookAtLH(eye: Vec3, target: Vec3, up: Vec3): Matrix {
		const z = normalizeVec3(subtractVec3(eye, target));
		const x = normalizeVec3(crossVec3(up, z));
		const y = crossVec3(z, x);
		return new Matrix([
			x.x,
			y.x,
			z.x,
			0,
			x.y,
			y.y,
			z.y,
			0,
			x.z,
			y.z,
			z.z,
			0,
			eye.x,
			eye.y,
			eye.z,
			1,
		]);
	}
	static ComposeToRef(
		scale: Vec3,
		rotation: Quaternion,
		translation: Vec3,
		result: Matrix,
	): Matrix {
		const m = rotation.toRotationMatrix().m;
		result.m[0] = m[0] * scale.x;
		result.m[1] = m[1] * scale.x;
		result.m[2] = m[2] * scale.x;
		result.m[3] = 0;
		result.m[4] = m[4] * scale.y;
		result.m[5] = m[5] * scale.y;
		result.m[6] = m[6] * scale.y;
		result.m[7] = 0;
		result.m[8] = m[8] * scale.z;
		result.m[9] = m[9] * scale.z;
		result.m[10] = m[10] * scale.z;
		result.m[11] = 0;
		result.m[12] = translation.x;
		result.m[13] = translation.y;
		result.m[14] = translation.z;
		result.m[15] = 1;
		return result;
	}

	clone(): Matrix {
		return new Matrix(this.m.slice());
	}
	copyFrom(src: Matrix): Matrix {
		this.m = src.m.slice();
		return this;
	}
	multiply(other: Matrix): Matrix {
		return Matrix.MultiplyToRef(this, other, new Matrix());
	}
	multiplyToRef(other: Matrix, result: Matrix): Matrix {
		return Matrix.MultiplyToRef(this, other, result);
	}
	static MultiplyToRef(left: Matrix, right: Matrix, result: Matrix): Matrix {
		const a = left.m;
		const b = right.m;
		const r = result.m;
		for (let i = 0; i < 4; i++) {
			const ai0 = a[i * 4];
			const ai1 = a[i * 4 + 1];
			const ai2 = a[i * 4 + 2];
			const ai3 = a[i * 4 + 3];
			r[i * 4] = ai0 * b[0] + ai1 * b[4] + ai2 * b[8] + ai3 * b[12];
			r[i * 4 + 1] = ai0 * b[1] + ai1 * b[5] + ai2 * b[9] + ai3 * b[13];
			r[i * 4 + 2] = ai0 * b[2] + ai1 * b[6] + ai2 * b[10] + ai3 * b[14];
			r[i * 4 + 3] = ai0 * b[3] + ai1 * b[7] + ai2 * b[11] + ai3 * b[15];
		}
		return result;
	}
	invert(): Matrix {
		return Matrix.InvertToRef(this, new Matrix());
	}
	static InvertToRef(matrix: Matrix, result: Matrix): Matrix {
		const m = matrix.m;
		const a00 = m[0];
		const a01 = m[1];
		const a02 = m[2];
		const a03 = m[3];
		const a10 = m[4];
		const a11 = m[5];
		const a12 = m[6];
		const a13 = m[7];
		const a20 = m[8];
		const a21 = m[9];
		const a22 = m[10];
		const a23 = m[11];
		const a30 = m[12];
		const a31 = m[13];
		const a32 = m[14];
		const a33 = m[15];
		const b00 = a00 * a11 - a01 * a10;
		const b01 = a00 * a12 - a02 * a10;
		const b02 = a00 * a13 - a03 * a10;
		const b03 = a01 * a12 - a02 * a11;
		const b04 = a01 * a13 - a03 * a11;
		const b05 = a02 * a13 - a03 * a12;
		const b06 = a20 * a31 - a21 * a30;
		const b07 = a20 * a32 - a22 * a30;
		const b08 = a20 * a33 - a23 * a30;
		const b09 = a21 * a32 - a22 * a31;
		const b10 = a21 * a33 - a23 * a31;
		const b11 = a22 * a33 - a23 * a32;
		let det =
			b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
		if (!det) return result.copyFrom(Matrix.Identity());
		det = 1.0 / det;
		const r = result.m;
		r[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
		r[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
		r[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
		r[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
		r[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
		r[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
		r[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
		r[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
		r[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
		r[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
		r[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
		r[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
		r[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
		r[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
		r[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
		r[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
		return result;
	}
	getTranslation(): Vec3 {
		return vec3(this.m[12], this.m[13], this.m[14]);
	}
	setTranslation(translation: Vec3): Matrix {
		this.m[12] = translation.x;
		this.m[13] = translation.y;
		this.m[14] = translation.z;
		return this;
	}
	decompose(scale?: Vec3, rotation?: Quaternion, translation?: Vec3): boolean {
		const sx = Math.hypot(this.m[0], this.m[1], this.m[2]);
		const sy = Math.hypot(this.m[4], this.m[5], this.m[6]);
		const sz = Math.hypot(this.m[8], this.m[9], this.m[10]);
		if (scale) {
			scale.x = sx;
			scale.y = sy;
			scale.z = sz;
		}
		const r = new Matrix([
			this.m[0] / sx,
			this.m[1] / sx,
			this.m[2] / sx,
			0,
			this.m[4] / sy,
			this.m[5] / sy,
			this.m[6] / sy,
			0,
			this.m[8] / sz,
			this.m[9] / sz,
			this.m[10] / sz,
			0,
			0,
			0,
			0,
			1,
		]);
		if (rotation) Quaternion.FromRotationMatrixToRef(r, rotation);
		if (translation) {
			translation.x = this.m[12];
			translation.y = this.m[13];
			translation.z = this.m[14];
		}
		return true;
	}
	determinant(): number {
		const m = this.m;
		return (
			m[0] *
				(m[5] * m[10] * m[15] -
					m[5] * m[11] * m[14] -
					m[9] * m[6] * m[15] +
					m[9] * m[7] * m[14] +
					m[13] * m[6] * m[11] -
					m[13] * m[7] * m[10]) -
			m[1] *
				(m[4] * m[10] * m[15] -
					m[4] * m[11] * m[14] -
					m[8] * m[6] * m[15] +
					m[8] * m[7] * m[14] +
					m[12] * m[6] * m[11] -
					m[12] * m[7] * m[10]) +
			m[2] *
				(m[4] * m[9] * m[15] -
					m[4] * m[11] * m[13] -
					m[8] * m[5] * m[15] +
					m[8] * m[7] * m[13] +
					m[12] * m[5] * m[11] -
					m[12] * m[7] * m[9]) -
			m[3] *
				(m[4] * m[9] * m[14] -
					m[4] * m[10] * m[13] -
					m[8] * m[5] * m[14] +
					m[8] * m[6] * m[13] +
					m[12] * m[5] * m[10] -
					m[12] * m[6] * m[9])
		);
	}
	toEulerAngles(): Vec3 {
		return this.toEulerAnglesToRef(vec3(0, 0, 0));
	}
	toEulerAnglesToRef(result: Vec3): Vec3 {
		const m = this.m;
		const sy = -m[2];
		if (Math.abs(sy) > 0.99999) {
			return setVec3(
				result,
				0,
				Math.asin(Math.max(-1, Math.min(1, sy))),
				Math.atan2(-m[4], m[0]),
			);
		}
		return setVec3(
			result,
			Math.atan2(m[6], m[10]),
			Math.asin(Math.max(-1, Math.min(1, sy))),
			Math.atan2(m[1], m[5]),
		);
	}
	toArray(): number[] {
		return this.m.slice();
	}
}

export class Observable<T> {
	#observers: Array<(data: T) => void> = [];
	#observerIds = new Map<number, (data: T) => void>();
	#nextId = 1;
	// Snapshot cache: notifyObservers used to call #observers.slice() on
	// every notify. The snapshot is only re-taken when the observer list
	// actually mutates, so the common no-change case iterates the cached
	// copy. Semantics are unchanged: observers added/removed during a
	// notify see the snapshot they would have seen before.
	#notifySnapshot: Array<(data: T) => void> | null = null;

	add(observer: (data: T) => void): number {
		const id = this.#nextId++;
		this.#observerIds.set(id, observer);
		this.#observers.push(observer);
		this.#notifySnapshot = null;
		return id;
	}
	addOnce(observer: (data: T) => void): number {
		const wrapped = (data: T) => {
			this.remove(id);
			observer(data);
		};
		const id = this.add(wrapped);
		return id;
	}
	remove(id: number): boolean {
		const obs = this.#observerIds.get(id);
		if (!obs) return false;
		this.#observerIds.delete(id);
		const idx = this.#observers.indexOf(obs);
		if (idx >= 0) this.#observers.splice(idx, 1);
		this.#notifySnapshot = null;
		return true;
	}
	removeCallback(observer: (data: T) => void): boolean {
		const idx = this.#observers.indexOf(observer);
		if (idx < 0) return false;
		this.#observers.splice(idx, 1);
		for (const [id, o] of this.#observerIds) {
			if (o === observer) this.#observerIds.delete(id);
		}
		this.#notifySnapshot = null;
		return true;
	}
	clear(): void {
		this.#observers = [];
		this.#observerIds.clear();
		this.#notifySnapshot = null;
	}
	notifyObservers(data: T): void {
		const list =
			this.#notifySnapshot ?? (this.#notifySnapshot = this.#observers.slice());
		for (const o of list) o(data);
	}
	get hasObservers(): boolean {
		return this.#observers.length > 0;
	}
}

export const Tools = {
	ToRadians: (value: number): number => (value * Math.PI) / 180,
	ToDegrees: (value: number): number => (value * 180) / Math.PI,
	Clamp: (value: number, min = 0, max = 1): number =>
		Math.min(max, Math.max(min, value)),
	Mix: (a: number, b: number, alpha: number): number => a + (b - a) * alpha,
	RandomFloat: (min: number, max: number): number =>
		min + Math.random() * (max - min),
	IsExponentOfTwo: (value: number): boolean =>
		(value & (value - 1)) === 0 && value !== 0,
	Now: (): number => Date.now(),
};

export const Scalar = {
	Clamp: (value: number, min = 0, max = 1): number =>
		Math.min(max, Math.max(min, value)),
	Lerp: (a: number, b: number, t: number): number => a + (b - a) * t,
	ToRadians: (v: number): number => (v * Math.PI) / 180,
	ToDegrees: (v: number): number => (v * 180) / Math.PI,
	Sign: (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0),
	WithinEpsilon: (a: number, b: number, eps = 1.401e-45): boolean =>
		Math.abs(a - b) <= eps,
};

export const Space = {
	LOCAL: 0,
	WORLD: 1,
	BOUNDING_BOX: 2,
};

export const Axis = {
	X: vec3(1, 0, 0),
	Y: vec3(0, 1, 0),
	Z: vec3(0, 0, 1),
};
