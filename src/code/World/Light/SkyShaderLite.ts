/**
 * Babylon Lite (native) port of the sky shader.
 * Needs `position` + `sunDirection`/`moonDirection`/`moonPhase`/`time`
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

// Integer cell hash: exact under f32, unlike fract(sin(dot)*43758) whose
// sin() of large arguments (|dot| ~ 18000 at STAR_SCALE 140) loses
// precision and clusters many cells onto near-identical values.
fn hash13(p : vec3<f32>) -> f32 {
  var q = vec3<u32>(vec3<i32>(p) + vec3<i32>(200, 200, 200));
  q = q * 1664525u + 1013904223u;
  q.x += q.y * q.z;
  q.y += q.z * q.x;
  q.z += q.x * q.y;
  q ^= q >> vec3<u32>(16u);
  q.x += q.y * q.z;
  return f32(q.x) / 4294967295.0;
}

// Placeholder for the future textured moon. moonUv spans [0, 1] across the
// disc, phase is 0 (new) .. 0.5 (full) .. 1 (new). Later: return
// textureSample(moonTexture, moonSampler, moonUv).rgb shaded by phase.
fn getMoonColor(moonUv : vec2<f32>, phase : f32) -> vec3<f32> {
  let limb = length(moonUv - vec2<f32>(0.5, 0.5)) * 2.0;
  let shade = 1.0 - limb * limb * 0.25;
  return vec3<f32>(0.92, 0.93, 0.96) * shade;
}

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

  // 1 at night, 0 by day. (Written as 1 - smoothstep so edge0 < edge1;
  // reversed edges are undefined behaviour in WGSL.)
  let night = 1.0 - smoothstep(-0.15, 0.15, shaderUniforms.sunDirection.y);

  // ---- Moon (placeholder disc; textured later via getMoonColor) ----
  let moonDir = normalize(shaderUniforms.moonDirection);
  let moonDot = dot(viewDirection, moonDir);
  let moonDisc = smoothstep(0.99988, 0.99995, moonDot);
  let moonGlow = smoothstep(0.997, 1.0, moonDot);
  // Illumination: 0 = new moon (invisible), 1 = full moon.
  let moonIllum = 0.5 - 0.5 * cos(shaderUniforms.moonPhase * 6.2831853);
  if (moonDisc > 0.0 || moonGlow > 0.0) {
    // Disc UV for the future texture: orthonormal basis around moonDir.
    let upRef = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(moonDir.y) > 0.99);
    let uAxis = normalize(cross(upRef, moonDir));
    let vAxis = cross(moonDir, uAxis);
    let offU = dot(viewDirection - moonDir * moonDot, uAxis);
    let offV = dot(viewDirection - moonDir * moonDot, vAxis);
    let moonUv = vec2<f32>(offU, offV) / 0.032 + vec2<f32>(0.5, 0.5);
    let moonTex = getMoonColor(moonUv, shaderUniforms.moonPhase);
    // New moon stays dark; a lit moon stays faintly visible by day, with the
    // daytime floor scaled by phase (full > quarter > new).
    let moonVis = (0.04 + 0.96 * moonIllum) * (0.25 + 0.75 * max(night, 0.35 * moonIllum));
    finalColor = finalColor + moonDisc * moonTex * moonVis * 1.2;
    finalColor = finalColor + moonGlow * vec3<f32>(0.55, 0.6, 0.75) * moonIllum * (0.05 + 0.3 * night);
  }

  // ---- Stars (procedural hash cells + twinkle, night only) ----
  let horizonFade = smoothstep(-0.08, 0.12, viewDirection.y);
  let starVis = night * horizonFade;
  if (starVis > 0.001) {
    let grid = viewDirection * 140.0;
    let cell = floor(grid);
    let h = hash13(cell);
    if (h > 0.992) {
      let pos = fract(grid) - vec3<f32>(0.5, 0.5, 0.5);
      let dist = length(pos);
      // Magnitude classes from INDEPENDENT cell hashes: deriving them
      // from h would correlate with the h > 0.992 star gate above
      // (fract(h*57) could only land in 0.54..1.0), forcing every star
      // bright with near-identical twinkle. Mostly dim/small stars, a few
      // bright/large ones; size varies with magnitude so bright stars read
      // as bigger, not just whiter.
      let mag = hash13(cell + vec3<f32>(19.0, 7.0, 5.0));
      let star = 1.0 - smoothstep(0.05, 0.1 + 0.3 * mag, dist);
      let base = 0.1 + 0.9 * mag * mag;
      let twAmt = 0.2 + 0.6 * hash13(cell + vec3<f32>(-13.0, 29.0, -7.0));
      let twinkle = 1.0 - twAmt * (0.5 + 0.5 * sin(shaderUniforms.time * 1.2 + h * 6.2831853));
      let brightness = base * twinkle;
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
			{ name: "moonPhase", type: "f32" },
			{ name: "time", type: "f32" },
		],
		backFaceCulling: false,
		depthWrite: false,
	});
	setShaderUniform(material, "sunDirection", [0, 1, 0]);
	setShaderUniform(material, "moonDirection", [0, -1, 0]);
	setShaderUniform(material, "moonPhase", 0.5);
	setShaderUniform(material, "time", 0);
	return material;
}
