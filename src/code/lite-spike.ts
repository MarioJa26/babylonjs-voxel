/**
 * Phase 0 feasibility spike for the Babylon Lite port.
 *
 * This file ONLY validates that the Lite API surface the chunk renderer depends on
 * type-checks. It is not meant to run (no GPU/browser here); WGSL correctness is
 * validated later in a WebGPU browser. The chunk face data (faceDataA/B/C +
 * chunkIndex) is repacked into the fixed standard vertex attributes
 * (position/normal/uv/uv2/color) and chunk offsets are baked into `position`,
 * so NO storage buffers are required.
 */
import {
	addToScene,
	createBox,
	createDirectionalLight,
	createEngine,
	createHemisphericLight,
	createMeshFromData,
	createSceneContext,
	createShaderMaterial,
	disposeEngine,
	disposeScene,
	type EngineContext,
	type Mesh,
	onBeforeRender,
	type SceneContext,
	type ShaderMaterial,
	setShaderUniform,
	startEngine,
} from "@babylonjs/lite";

// ---------------------------------------------------------------------------
// Repacked chunk geometry (what the mesher will actually produce).
//   position : baked local position (center + corner, +chunk offset)
//   normal   : axis-aligned face normal
//   uv       : quad corner UV (0/1)
//   uv2      : atlas tile index (tileX, tileY)
//   color    : (packedAO, light, meta, unused)
// ---------------------------------------------------------------------------
function buildSpikeGeometry() {
	const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
	const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
	const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
	const uv2s = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]);
	const colors = new Float32Array([
		1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1,
	]);
	const indices = new Uint32Array([0, 2, 1, 0, 3, 2]);
	return { positions, normals, uvs, uv2s, colors, indices };
}

// WGSL following Lite's verified ShaderMaterial contract:
//   - entry points are `mainVertex` / `mainFragment`
//   - vertex inputs arrive via the auto-generated `VertexInput` struct
//     (@location(i) = attribute order: position0 normal1 uv2 uv2=3 color=4)
//   - system uniforms: `shaderSystem.<name>`  (group1 binding0)
//   - custom uniforms: `shaderUniforms.<name>` (group1 binding1)
//   - sampler "X": `X` (texture_2d) + `XSampler` (sampler)
const vertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vUV : vec2<f32>,
  @location(1) vUV2 : vec2<f32>,
  @location(2) vColor : vec4<f32>,
  @location(3) vNormal : vec3<f32>,
  @location(4) vWorld : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vUV = input.uv;
  out.vUV2 = input.uv2;
  out.vColor = input.color;
  out.vNormal = input.normal;
  out.vWorld = input.position;
  return out;
}
`;

const fragmentWGSL = /* wgsl */ `
@fragment
fn mainFragment(
  @location(0) vUV : vec2<f32>,
  @location(1) vUV2 : vec2<f32>,
  @location(2) vColor : vec4<f32>,
  @location(3) vNormal : vec3<f32>,
  @location(4) vWorld : vec3<f32>,
) -> @location(0) vec4<f32> {
  _ = shaderUniforms.wetness;
  return vec4<f32>(vNormal * 0.5 + 0.5, 1.0);
}
`;

export async function runLiteSpike(canvas: HTMLCanvasElement): Promise<{
	engine: EngineContext;
	scene: SceneContext;
	mesh: Mesh;
	material: ShaderMaterial;
	teardown: () => void;
}> {
	const engine = await createEngine(canvas);
	const scene = createSceneContext(engine);

	// Lights (Lite uses plain data; no scene in constructor).
	const hemi = createHemisphericLight([0.1, 1, 0.1], 1.0);
	const dir = createDirectionalLight([0, -1, 0], 1.0);
	addToScene(scene, hemi);
	addToScene(scene, dir);

	// Chunk-style custom shader material (WGSL).
	const material = createShaderMaterial({
		name: "chunkSpike",
		vertexSource: vertexWGSL,
		fragmentSource: fragmentWGSL,
		attributes: ["position", "normal", "uv", "uv2", "color"],
		uniforms: [
			"worldViewProjection",
			"cameraPosition",
			{ name: "atlasTileSize", type: "f32" },
			{ name: "atlasMaxTiles", type: "f32" },
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "wetness", type: "f32" },
		],
		samplers: ["diffuseTexture", "normalTexture"],
		backFaceCulling: true,
	});

	// Per-frame uniforms (cameraPosition is automatic).
	setChunkUniforms(material);

	// Geometry via the fixed attribute set.
	const g = buildSpikeGeometry();
	const mesh = createMeshFromData(
		engine,
		"chunkSpike",
		g.positions,
		g.normals,
		g.indices,
		g.uvs,
		g.uv2s,
		undefined, // tangents
		g.colors,
	);
	mesh.material = material;
	addToScene(scene, mesh);

	// A plain primitive entity to confirm MeshBuilder -> factory mapping.
	const box = createBox(engine, 1);
	addToScene(scene, box);

	onBeforeRender(scene, (_deltaMs: number) => {
		setChunkUniforms(material);
	});

	await startEngine(engine);

	return {
		engine,
		scene,
		mesh,
		material,
		teardown: () => {
			disposeScene(scene);
			disposeEngine(engine);
		},
	};
}

function setChunkUniforms(material: ShaderMaterial): void {
	// setShaderUniform accepts number | readonly number[] | Float32Array.
	setShaderUniform(material, "atlasTileSize", 1 / 16);
	setShaderUniform(material, "atlasMaxTiles", 16);
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "wetness", 0);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
}
