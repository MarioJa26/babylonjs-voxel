/**
 * Babylon Lite (native) port of the sky shader.
 * Only needs `position` + a `sunDirection` uniform. The skybox mesh is a sphere
 * (createSphere) centered on the camera — WorldEnvironment keeps it camera-locked.
 */
import {
	createShaderMaterial,
	type EngineContext,
	type SceneContext,
	type ShaderMaterial,
	setShaderUniform,
} from "@babylonjs/lite";

export const skyVertexWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPosition : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;
  out.pos = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.vPosition = input.position;
  return out;
}
`;

export const skyFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPosition : vec3<f32>,
};

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let viewDirection = normalize(in.vPosition);

  let skyFactor = smoothstep(0.0, 0.4, viewDirection.y);
  var skyColor = mix(vec3<f32>(0.5, 0.7, 0.9), vec3<f32>(0.1, 0.3, 0.6), skyFactor);

  let sunDot = dot(viewDirection, shaderUniforms.sunDirection);
  let sunDisc = smoothstep(0.9998875, 0.99995, sunDot);
  let sunGlow = smoothstep(0.995, 1.0, sunDot);

  var finalColor = skyColor;
  finalColor = finalColor + sunGlow * vec3<f32>(1.0, 0.9, 0.7) * 0.3;
  finalColor = finalColor + sunDisc * vec3<f32>(1.0, 1.0, 0.9);

  if (shaderUniforms.sunDirection.y < 0.0) {
    finalColor = mix(finalColor, vec3<f32>(0.1, 0.1, 0.2), -shaderUniforms.sunDirection.y * 2.0);
  }

  return vec4<f32>(clamp(finalColor, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;

export function createSkyMaterial(): ShaderMaterial {
	const material = createShaderMaterial({
		name: "skyLite",
		vertexSource: skyVertexWGSL,
		fragmentSource: skyFragmentWGSL,
		attributes: ["position"],
		uniforms: [
			"worldViewProjection",
			{ name: "sunDirection", type: "vec3<f32>" },
		],
		backFaceCulling: false,
		depthWrite: false,
	});
	setShaderUniform(material, "sunDirection", [0, 1, 0]);
	return material;
}
