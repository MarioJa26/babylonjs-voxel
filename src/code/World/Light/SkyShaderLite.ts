/**
 * Babylon Lite (native) port of the sky shader.
 *
 * Moon basis vectors are prepared per vertex and interpolated across the
 * skybox. Because the basis is constant for the entire draw, interpolation
 * produces the same value for every fragment while avoiding repeated
 * cross products and normalization in the fragment shader.
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
  @location(1) moonUAxis : vec3<f32>,
  @location(2) moonVAxis : vec3<f32>,
};

@vertex
fn mainVertex(input : VertexInput) -> VSOut {
  var out : VSOut;

  let moonDir = shaderUniforms.moonDirection;
  let upRef = select(
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(1.0, 0.0, 0.0),
    abs(moonDir.y) > 0.99
  );
  let moonUAxis = normalize(cross(upRef, moonDir));

  out.pos =
    shaderSystem.worldViewProjection *
    vec4<f32>(input.position, 1.0);
  out.vPosition = input.position;
  out.moonUAxis = moonUAxis;
  out.moonVAxis = cross(moonDir, moonUAxis);

  return out;
}
`;

export const skyFragmentWGSL = /* wgsl */ `
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) vPosition : vec3<f32>,
  @location(1) moonUAxis : vec3<f32>,
  @location(2) moonVAxis : vec3<f32>,
};

const TAU = 6.2831853;

const DAY_HORIZON_COLOR = vec3<f32>(0.5, 0.7, 0.9);
const DAY_ZENITH_COLOR = vec3<f32>(0.1, 0.3, 0.6);
const NIGHT_SKY_COLOR = vec3<f32>(0.1, 0.1, 0.2);

const SUN_GLOW_COLOR = vec3<f32>(1.0, 0.9, 0.7);
const SUN_DISC_COLOR = vec3<f32>(1.0, 1.0, 0.9);

const MOON_BASE_COLOR = vec3<f32>(0.92, 0.93, 0.96);
const MOON_HALO_COLOR = vec3<f32>(0.55, 0.6, 0.75);
const STAR_COLOR = vec3<f32>(0.9, 0.93, 1.0);

const MOON_UV_SCALE = 31.25;
const HASH_TO_FLOAT = 1.0 / 4294967295.0;

// Cheap integer cell hash. All star-cell coordinates remain in a range that
// converts exactly to integer values before hashing.
fn hash13(p : vec3<f32>) -> f32 {
  let q = vec3<u32>(vec3<i32>(p) + vec3<i32>(200));

  var h =
    q.x * 374761393u +
    q.y * 668265263u +
    q.z * 1440662683u;

  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);

  return f32(h) * HASH_TO_FLOAT;
}

// Placeholder for a future textured moon. moonUv spans [0, 1] across
// the disc.
fn getMoonColor(moonUv : vec2<f32>) -> vec3<f32> {
  let centeredUv = moonUv - vec2<f32>(0.5);
  let normalizedRadiusSquared = dot(centeredUv, centeredUv) * 4.0;

  // Equivalent to:
  // 1.0 - pow(length(centeredUv) * 2.0, 2.0) * 0.25
  return MOON_BASE_COLOR * (1.0 - normalizedRadiusSquared * 0.25);
}

@fragment
fn mainFragment(in : VSOut) -> @location(0) vec4<f32> {
  let viewDirection = normalize(in.vPosition);
  let sunDirection = shaderUniforms.sunDirection;
  let sunHeight = sunDirection.y;

  let skyFactor = smoothstep(0.0, 0.4, viewDirection.y);

  var finalColor = mix(
    DAY_HORIZON_COLOR,
    DAY_ZENITH_COLOR,
    skyFactor
  );

  let sunDot = dot(viewDirection, sunDirection);

  let sunGlow = smoothstep(0.995, 1.0, sunDot);
  let sunDisc = smoothstep(0.9998875, 0.99995, sunDot);

  finalColor += sunGlow * SUN_GLOW_COLOR * 0.3;
  finalColor += sunDisc * SUN_DISC_COLOR;

  if (sunHeight < 0.0) {
    finalColor = mix(
      finalColor,
      NIGHT_SKY_COLOR,
      min(-sunHeight * 2.0, 1.0)
    );
  }

  // 1 at night and 0 by day. Reversed smoothstep edges are avoided because
  // their behavior is undefined in WGSL.
  let night = 1.0 - smoothstep(-0.15, 0.15, sunHeight);

  // Moon calculations are skipped when illumination is negligible.
  let moonIllum = shaderUniforms.moonIllum;

  if (moonIllum > 0.01) {
    let moonDot = dot(
      viewDirection,
      shaderUniforms.moonDirection
    );

    if (moonDot > 0.997) {
      let moonOffset = vec2<f32>(
        dot(viewDirection, in.moonUAxis),
        dot(viewDirection, in.moonVAxis)
      );

      let moonUv =
        moonOffset * MOON_UV_SCALE +
        vec2<f32>(0.5);

      // A full moon remains faintly visible during the day.
      let moonVisibility =
        moonIllum *
        (0.2 + 0.8 * night);

      let moonLight =
        getMoonColor(moonUv) *
        moonVisibility;

      let moonDisc =
        smoothstep(0.99988, 0.99995, moonDot);

      let moonHalo =
        smoothstep(0.997, 1.0, moonDot);

      finalColor += moonDisc * moonLight * 1.2;
      finalColor +=
        moonHalo *
        MOON_HALO_COLOR *
        moonVisibility *
        0.35;
    }
  }

  // Stars are evaluated only above the horizon and when sufficiently dark.
  let starVisibility =
    night *
    smoothstep(-0.08, 0.12, viewDirection.y);

  if (starVisibility > 0.001) {
    let grid = viewDirection * 140.0;
    let cell = floor(grid);
    let presenceHash = hash13(cell);

    if (presenceHash > 0.992) {
      // Independent hashes prevent magnitude, twinkle depth, and phase from
      // becoming correlated with the star-presence threshold.
      let magnitude = hash13(
        cell + vec3<f32>(19.0, 7.0, 5.0)
      );

      let localPosition =
        fract(grid) -
        vec3<f32>(0.5);

      let starShape =
        1.0 -
        smoothstep(
          0.05,
          0.1 + 0.3 * magnitude,
          length(localPosition)
        );

      let twinkleAmount =
        0.2 +
        0.6 *
        hash13(cell + vec3<f32>(-13.0, 29.0, -7.0));

      let twinklePhase =
        hash13(cell + vec3<f32>(-5.0, 17.0, -23.0)) *
        TAU;

      let twinkle =
        1.0 -
        twinkleAmount *
        (
          0.5 +
          0.5 *
          sin(shaderUniforms.time * 1.2 + twinklePhase)
        );

      let brightness =
        (0.1 + 0.9 * magnitude * magnitude) *
        twinkle;

      finalColor +=
        STAR_COLOR *
        starShape *
        brightness *
        starVisibility;
    }
  }

  return vec4<f32>(
    clamp(
      finalColor,
      vec3<f32>(0.0),
      vec3<f32>(1.0)
    ),
    1.0
  );
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
