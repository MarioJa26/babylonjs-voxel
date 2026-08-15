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

const BOX_INDICES = new Uint32Array([
	0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14,
	15, 16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23,
]);

const BOX_NORMALS = new Float32Array([
	// +X
	1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
	// -X
	-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
	// +Y
	0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
	// -Y
	0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
	// +Z
	0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
	// -Z
	0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
]);

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
	const hx = width * 0.5;
	const hy = height * 0.5;
	const hz = depth * 0.5;

	const positions = new Float32Array(72);

	// +X
	positions[0] = hx;
	positions[1] = -hy;
	positions[2] = -hz;
	positions[3] = hx;
	positions[4] = -hy;
	positions[5] = hz;
	positions[6] = hx;
	positions[7] = hy;
	positions[8] = hz;
	positions[9] = hx;
	positions[10] = hy;
	positions[11] = -hz;

	// -X
	positions[12] = -hx;
	positions[13] = -hy;
	positions[14] = hz;
	positions[15] = -hx;
	positions[16] = -hy;
	positions[17] = -hz;
	positions[18] = -hx;
	positions[19] = hy;
	positions[20] = -hz;
	positions[21] = -hx;
	positions[22] = hy;
	positions[23] = hz;

	// +Y
	positions[24] = -hx;
	positions[25] = hy;
	positions[26] = -hz;
	positions[27] = hx;
	positions[28] = hy;
	positions[29] = -hz;
	positions[30] = hx;
	positions[31] = hy;
	positions[32] = hz;
	positions[33] = -hx;
	positions[34] = hy;
	positions[35] = hz;

	// -Y
	positions[36] = -hx;
	positions[37] = -hy;
	positions[38] = hz;
	positions[39] = hx;
	positions[40] = -hy;
	positions[41] = hz;
	positions[42] = hx;
	positions[43] = -hy;
	positions[44] = -hz;
	positions[45] = -hx;
	positions[46] = -hy;
	positions[47] = -hz;

	// +Z
	positions[48] = -hx;
	positions[49] = -hy;
	positions[50] = hz;
	positions[51] = -hx;
	positions[52] = hy;
	positions[53] = hz;
	positions[54] = hx;
	positions[55] = hy;
	positions[56] = hz;
	positions[57] = hx;
	positions[58] = -hy;
	positions[59] = hz;

	// -Z
	positions[60] = hx;
	positions[61] = -hy;
	positions[62] = -hz;
	positions[63] = hx;
	positions[64] = hy;
	positions[65] = -hz;
	positions[66] = -hx;
	positions[67] = hy;
	positions[68] = -hz;
	positions[69] = -hx;
	positions[70] = -hy;
	positions[71] = -hz;

	return {
		positions,
		normals: BOX_NORMALS,
		indices: BOX_INDICES,
	};
}

export { createMeshFromData };
