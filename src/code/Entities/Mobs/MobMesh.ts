import {
	createMeshFromData,
	createShaderMaterial,
	type ShaderMaterial,
	setShaderUniform,
} from "@babylonjs/lite";
import type { Color3 } from "@/code/Lib/Math";

const MOB_VERTEX_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vNormal : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vNormal = input.normal;
  return out;
}
`;

const MOB_FRAGMENT_WGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vNormal : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.vNormal);
  let light = clamp(0.45 + 0.55 * n.y, 0.0, 1.0);
  return vec4<f32>(shaderUniforms.tintColor * light, 1.0);
}
`;

export function createMobColorMaterial(
	color: Color3,
	name: string,
): ShaderMaterial {
	const material = createShaderMaterial({
		name,
		vertexSource: MOB_VERTEX_WGSL,
		fragmentSource: MOB_FRAGMENT_WGSL,
		attributes: ["position", "normal"],
		uniforms: [
			"world",
			"worldViewProjection",
			{ name: "tintColor", type: "vec3<f32>" },
		],
		backFaceCulling: true,
	});
	setShaderUniform(material, "tintColor", [color.r, color.g, color.b]);
	return material;
}

export function buildBoxGeometry(
	width: number,
	height: number,
	depth: number,
): {
	positions: Float32Array;
	normals: Float32Array;
	indices: Uint32Array;
} {
	const hx = width / 2;
	const hy = height / 2;
	const hz = depth / 2;

	const faceList: Array<{
		normal: [number, number, number];
		verts: Array<[number, number, number]>;
	}> = [
		{
			normal: [1, 0, 0],
			verts: [
				[hx, -hy, -hz],
				[hx, -hy, hz],
				[hx, hy, hz],
				[hx, hy, -hz],
			],
		},
		{
			normal: [-1, 0, 0],
			verts: [
				[-hx, -hy, hz],
				[-hx, -hy, -hz],
				[-hx, hy, -hz],
				[-hx, hy, hz],
			],
		},
		{
			normal: [0, 1, 0],
			verts: [
				[-hx, hy, -hz],
				[hx, hy, -hz],
				[hx, hy, hz],
				[-hx, hy, hz],
			],
		},
		{
			normal: [0, -1, 0],
			verts: [
				[-hx, -hy, hz],
				[hx, -hy, hz],
				[hx, -hy, -hz],
				[-hx, -hy, -hz],
			],
		},
		{
			normal: [0, 0, 1],
			verts: [
				[-hx, -hy, hz],
				[-hx, hy, hz],
				[hx, hy, hz],
				[hx, -hy, hz],
			],
		},
		{
			normal: [0, 0, -1],
			verts: [
				[hx, -hy, -hz],
				[hx, hy, -hz],
				[-hx, hy, -hz],
				[-hx, -hy, -hz],
			],
		},
	];

	const positions: number[] = [];
	const normals: number[] = [];
	const indices: number[] = [];

	for (const face of faceList) {
		const base = positions.length / 3;
		for (let i = 0; i < 4; i++) {
			positions.push(...face.verts[i]);
			normals.push(...face.normal);
		}
		indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
	}

	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		indices: new Uint32Array(indices),
	};
}

export { createMeshFromData };
