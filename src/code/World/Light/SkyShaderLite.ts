/**
 * Babylon Lite (native) port of the sky shader.
 * Needs `position` + `sunDirection`/`moonDirection`/`moonIllum`/`time`
 * uniforms (driven by WorldEnvironment). The skybox mesh is a
 * camera-centred box (WorldEnvironment keeps it camera-locked); any
 * star-shaped surface around the camera produces identical output because
 * the fragment shader only uses normalize(vPosition).
 *
 * Moon: placeholder procedural disc opposite the sun's schedule (see
 * WorldEnvironment moon math). getMoonColor() is the seam for a future
 * textured moon — swap its body for a texture sample using the provided
 * disc UV + phase without touching the disc/halo compositing.
 */
import {
	createShaderMaterial,
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

const TAU = 6.2831853;

// Cheap integer cell hash: exact under f32, unlike fract(sin(dot)*43758)
// whose sin() of large arguments loses precision and clusters many cells.
fn hash13(p : vec3<f32>) -> f32 {
  let q = vec3<u32>(vec3<i32>(p) + 200);
  var h = q.x * 374761393u + q.y * 668265263u + q.z * 1440662683u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) / 4294967295.0;
}

// Placeholder for the future textured moon: moonUv spans [0, 1] across the
// disc.
fn getMoonColor(moonUv : vec2<f32>) -> vec3<f32> {
  let d = length(moonUv - vec2<f32>(0.5)) * 2.0;
  return vec3<f32>(0.92, 0.93, 0.96) * (1.0 - d * d * 0.25);
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let viewDirection = normalize(in.vPosition);

  let skyFactor = smoothstep(0.0, 0.4, viewDirection.y);
  var finalColor = mix(vec3<f32>(0.5, 0.7, 0.9), vec3<f32>(0.1, 0.3, 0.6), skyFactor);

  let sunDot = dot(viewDirection, shaderUniforms.sunDirection);
  finalColor = finalColor + smoothstep(0.995, 1.0, sunDot) * vec3<f32>(1.0, 0.9, 0.7) * 0.3;
  finalColor = finalColor + smoothstep(0.9998875, 0.99995, sunDot) * vec3<f32>(1.0, 1.0, 0.9);

  if (shaderUniforms.sunDirection.y < 0.0) {
    finalColor = mix(finalColor, vec3<f32>(0.1, 0.1, 0.2), -shaderUniforms.sunDirection.y * 2.0);
  }

  // 1 at night, 0 by day (1 - smoothstep: reversed edges are UB in WGSL).
  let night = 1.0 - smoothstep(-0.15, 0.15, shaderUniforms.sunDirection.y);

  // ---- Moon: placeholder disc (getMoonColor is the seam for a texture) ----
  // moonDirection must stay normalized (WorldEnvironment guarantees it), so
  // no per-pixel normalize. moonIllum 0 = new moon: skip the block entirely.
  let moonDot = dot(viewDirection, shaderUniforms.moonDirection);
  if (moonDot > 0.997 && shaderUniforms.moonIllum > 0.01) {
    // Disc UV for the future texture (axes are ⊥ moonDir, so projecting
    // viewDirection alone is exact).
    let moonDir = shaderUniforms.moonDirection;
    let upRef = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(moonDir.y) > 0.99);
    let uAxis = normalize(cross(upRef, moonDir));
    let off = vec2<f32>(dot(viewDirection, uAxis), dot(viewDirection, cross(moonDir, uAxis)));
    // Full moon is faintly visible by day; illumination is precomputed on CPU.
    let moonVis = shaderUniforms.moonIllum * (0.2 + 0.8 * night);
    let moonLight = getMoonColor(off / 0.032 + vec2<f32>(0.5, 0.5)) * moonVis;
    finalColor = finalColor + smoothstep(0.99988, 0.99995, moonDot) * moonLight * 1.2;
    finalColor = finalColor + smoothstep(0.997, 1.0, moonDot) * vec3<f32>(0.55, 0.6, 0.75) * moonVis * 0.35;
  }

  // ---- Stars: hash cells + twinkle, night only ----
  let starVis = night * smoothstep(-0.08, 0.12, viewDirection.y);
  if (starVis > 0.001) {
    let grid = viewDirection * 140.0;
    let cell = floor(grid);
    let h = hash13(cell);
    if (h > 0.992) {
      // Magnitude, twinkle depth AND phase use independent hashes: h is
      // gated to 0.992..1.0, so deriving anything from it traps that value
      // in a tiny range (same brightness, twinkling in unison).
      let mag = hash13(cell + vec3<f32>(19.0, 7.0, 5.0));
      let star = 1.0 - smoothstep(0.05, 0.1 + 0.3 * mag, length(fract(grid) - vec3<f32>(0.5)));
      let twAmt = 0.2 + 0.6 * hash13(cell + vec3<f32>(-13.0, 29.0, -7.0));
      let twPhase = hash13(cell + vec3<f32>(-5.0, 17.0, -23.0)) * TAU;
      let brightness = (0.1 + 0.9 * mag * mag) * (1.0 - twAmt * (0.5 + 0.5 * sin(shaderUniforms.time * 1.2 + twPhase)));
      finalColor = finalColor + vec3<f32>(0.9, 0.93, 1.0) * (star * brightness * starVis);
    }
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
			{ name: "moonDirection", type: "vec3<f32>" },
			{ name: "moonIllum", type: "f32" },
			{ name: "time", type: "f32" },
		],
		backFaceCulling: false,
		depthWrite: false,
	});
	setShaderUniform(material, "sunDirection", [0, 1, 0]);
	setShaderUniform(material, "moonDirection", [0, -1, 0]);
	setShaderUniform(material, "moonIllum", 1);
	setShaderUniform(material, "time", 0);
	return material;
}
