export class Lod3Shader {
  public static readonly chunkVertexShader = `
    #version 300 es
    precision mediump float;

    in vec3 position;
    in vec4 faceDataA; // x,y,z origin, w = axisFace(0..5)
    in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
    in vec4 faceDataC; // x=packedAO (unused), y=light, z=tintBucket, w=meta

    uniform mat4 world;
    uniform mat4 worldViewProjection;
    uniform float atlasTileSize;

    out vec2 vUV;
    flat out vec2 vUV2;
    flat out float vSkyLight;
    flat out float vBlockLight;
    flat out float vFaceShade;
    flat out vec3 vFaceNormalW;
    flat out float vTintBucket;
    out vec3 vPositionW;

    vec2 cornerToUV(int corner) {
      return vec2(
        (corner == 1 || corner == 2) ? 1.0 : 0.0,
        corner >= 2 ? 1.0 : 0.0
      );
    }

    void main(void) {
      int axisFace = int(faceDataA.w + 0.5);
      int axis = axisFace >> 1;
      int isBackFace = axisFace & 1;
      int vertexId = int(position.x + 0.5);

      // Fixed triangle layout for LOD3:
      // front = [0,2,1, 0,3,2]
      // back  = [0,1,2, 0,2,3]
      const int frontCorners[6] = int[](0, 2, 1, 0, 3, 2);
      const int backCorners[6] = int[](0, 1, 2, 0, 2, 3);
      int corner = isBackFace == 1 ? backCorners[vertexId] : frontCorners[vertexId];

      const float invPosScale = 0.25;
      float faceWidth = faceDataB.x * invPosScale;
      float faceHeight = faceDataB.y * invPosScale;

      vec2 cornerUV = cornerToUV(corner);
      float du = cornerUV.x * faceWidth;
      float dv = cornerUV.y * faceHeight;

      int uAxis = (axis + 1) % 3;
      int vAxis = (axis + 2) % 3;

      vec3 localPosition = faceDataA.xyz * invPosScale;

      if (uAxis == 0) localPosition.x += du;
      else if (uAxis == 1) localPosition.y += du;
      else localPosition.z += du;

      if (vAxis == 0) localPosition.x += dv;
      else if (vAxis == 1) localPosition.y += dv;
      else localPosition.z += dv;

      gl_Position = worldViewProjection * vec4(localPosition, 1.0);
      vPositionW = (world * vec4(localPosition, 1.0)).xyz;

      vUV = cornerToUV(corner);

      float maxTiles = floor(1.0 / atlasTileSize + 0.5);
      vUV2 = vec2(faceDataB.z, maxTiles - 1.0 - faceDataB.w) * atlasTileSize;

      int light = int(faceDataC.y);
      vSkyLight = float(light >> 4) * 0.0666666;
      vBlockLight = float(light & 0xF) * 0.0666666;
      vTintBucket = faceDataC.z;

      vec3 normal = vec3(0.0);
      if (axis == 0) normal.x = isBackFace == 1 ? -1.0 : 1.0;
      else if (axis == 1) normal.y = isBackFace == 1 ? -1.0 : 1.0;
      else normal.z = isBackFace == 1 ? -1.0 : 1.0;
      vFaceNormalW = normalize(mat3(world) * normal);

      // AO impostor by face axis:
      // top=1.0, side=0.78, bottom=0.58
      if (axis == 1) {
        vFaceShade = isBackFace == 1 ? 0.58 : 1.0;
      } else {
        vFaceShade = 0.78;
      }
    }
  `;

  public static readonly opaqueFragmentShader = `
    #version 300 es
    precision mediump float;

    in vec2 vUV;
    flat in vec2 vUV2;
    flat in float vSkyLight;
    flat in float vBlockLight;
    flat in float vFaceShade;
    flat in vec3 vFaceNormalW;
    flat in float vTintBucket;
    in vec3 vPositionW;

    uniform sampler2D diffuseTexture;
    uniform float atlasTileSize;
    uniform vec4 vFogInfos;
    uniform vec3 vFogColor;
    uniform float lodFadeProgress;
    uniform float lodFadeDirection;
    uniform float lodFadeSeed;

    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
    };

    out vec4 fragColor;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void applyDitherFade() {
      if (abs(lodFadeDirection) < 0.5) {
        return;
      }
      float n = hash12(floor(gl_FragCoord.xy) + vec2(lodFadeSeed, lodFadeSeed * 1.37));
      if (lodFadeDirection > 0.0) {
        if (n > lodFadeProgress) discard;
      } else {
        if (n < lodFadeProgress) discard;
      }
    }

    vec3 applyTintBucket(vec3 color, float bucket) {
      float b = floor(bucket + 0.5);
      vec3 tint = vec3(1.0);
      float sat = 1.0;

      if (b == 1.0) {
        tint = vec3(0.96, 0.98, 1.02);
        sat = 0.88;
      } else if (b == 2.0) {
        tint = vec3(1.04, 1.00, 0.92);
        sat = 0.90;
      } else if (b == 3.0) {
        tint = vec3(0.92, 1.06, 0.92);
        sat = 1.05;
      } else if (b == 4.0) {
        tint = vec3(0.90, 0.98, 1.08);
        sat = 0.90;
      } else if (b == 5.0) {
        tint = vec3(1.05, 0.97, 0.90);
        sat = 0.95;
      }

      float lum = dot(color, vec3(0.299, 0.587, 0.114));
      vec3 saturated = mix(vec3(lum), color, sat);
      return saturated * tint;
    }

    const vec3 DEEP_BLUE = vec3(0.1, 0.2, 0.4);
    const vec3 LIGHT_BLUE = vec3(0.6, 0.75, 0.95);
    const vec3 DARK_SKY = vec3(0.1, 0.1, 0.2);
    const vec3 MID_SKY = vec3(0.5, 0.7, 0.9);
    const vec3 DAY_SKY = vec3(0.1, 0.3, 0.6);
    const float HEIGHT_SCALE = 0.003;
    const float HEIGHT_OFFSET = 0.04;
    const float SKYBLEND_DIST = 1400.0;
    const float SKYBLEND_FACTOR = 0.0003333;

    vec3 getAtmosphereColor(float heightFactor) {
      return mix(LIGHT_BLUE, DEEP_BLUE, heightFactor) * (sunLightIntensity * sunLightIntensity);
    }

    vec3 getSkyboxColor(float viewDirY) {
      float skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
      vec3 skyboxColor = mix(MID_SKY, DAY_SKY, skyFactor);
      vec3 skyDir = -lightDirection;
      if (skyDir.y > 0.0) {
        skyboxColor = mix(skyboxColor, DARK_SKY, skyDir.y * 2.0);
      }
      return skyboxColor;
    }

    vec3 applyDistantFog(vec3 inputColor) {
      vec3 viewVec = vPositionW - cameraPosition;
      float dist = length(viewVec);
      float fogFactor = clamp((vFogInfos.z - dist) / max(vFogInfos.z - vFogInfos.y, 1.0), 0.0, 1.0);

      float heightFactor = clamp((vPositionW.y - dist * HEIGHT_OFFSET) * HEIGHT_SCALE, 0.0, 1.0);
      vec3 atmosphereColor = getAtmosphereColor(heightFactor);
      vec3 baseFogColor = mix(vFogColor, atmosphereColor, 0.8);

      float viewDirY = viewVec.y / max(dist, 1e-4);
      vec3 skyboxColor = getSkyboxColor(viewDirY);

      float skyBlend = clamp((dist - SKYBLEND_DIST) * SKYBLEND_FACTOR, 0.0, 1.0);
      vec3 effectiveFogColor = mix(baseFogColor, skyboxColor, skyBlend);

      return mix(effectiveFogColor, inputColor, fogFactor);
    }

    void main(void) {
      applyDitherFade();

      vec2 atlasUV = vUV2 + vUV * atlasTileSize;
      vec4 tex = texture(diffuseTexture, atlasUV);

      float sun = clamp(sunLightIntensity, 0.0, 1.0);
      float skyTerm = vSkyLight * (0.15 + 0.85 * sun);
      float blockTerm = vBlockLight;
      float light = clamp(max(skyTerm, blockTerm), 0.0, 1.0);

      float faceShade = vFaceShade;
      float horizon = clamp(dot(normalize(vFaceNormalW), lightDirection) * 0.5 + 0.5, 0.65, 1.0);
      light = clamp(light * faceShade * horizon, 0.0, 1.0);

      vec3 color = applyTintBucket(tex.rgb, vTintBucket) * light;

      color = applyDistantFog(color);

      fragColor = vec4(color, 1.0);
    }
  `;

  public static readonly transparentFragmentShader = `
    #version 300 es
    precision mediump float;

    in vec2 vUV;
    flat in vec2 vUV2;
    flat in float vSkyLight;
    flat in float vBlockLight;
    flat in float vFaceShade;
    flat in vec3 vFaceNormalW;
    flat in float vTintBucket;
    in vec3 vPositionW;

    uniform sampler2D diffuseTexture;
    uniform float atlasTileSize;
    uniform vec4 vFogInfos;
    uniform vec3 vFogColor;
    uniform float lodFadeProgress;
    uniform float lodFadeDirection;
    uniform float lodFadeSeed;

    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
    };

    out vec4 fragColor;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void applyDitherFade() {
      if (abs(lodFadeDirection) < 0.5) {
        return;
      }
      float n = hash12(floor(gl_FragCoord.xy) + vec2(lodFadeSeed, lodFadeSeed * 1.37));
      if (lodFadeDirection > 0.0) {
        if (n > lodFadeProgress) discard;
      } else {
        if (n < lodFadeProgress) discard;
      }
    }

    vec3 applyTintBucket(vec3 color, float bucket) {
      float b = floor(bucket + 0.5);
      vec3 tint = vec3(1.0);
      float sat = 1.0;

      if (b == 1.0) {
        tint = vec3(0.96, 0.98, 1.02);
        sat = 0.88;
      } else if (b == 2.0) {
        tint = vec3(1.04, 1.00, 0.92);
        sat = 0.90;
      } else if (b == 3.0) {
        tint = vec3(0.92, 1.06, 0.92);
        sat = 1.05;
      } else if (b == 4.0) {
        tint = vec3(0.90, 0.98, 1.08);
        sat = 0.90;
      } else if (b == 5.0) {
        tint = vec3(1.05, 0.97, 0.90);
        sat = 0.95;
      }

      float lum = dot(color, vec3(0.299, 0.587, 0.114));
      vec3 saturated = mix(vec3(lum), color, sat);
      return saturated * tint;
    }

    const vec3 DEEP_BLUE = vec3(0.1, 0.2, 0.4);
    const vec3 LIGHT_BLUE = vec3(0.6, 0.75, 0.95);
    const vec3 DARK_SKY = vec3(0.1, 0.1, 0.2);
    const vec3 MID_SKY = vec3(0.5, 0.7, 0.9);
    const vec3 DAY_SKY = vec3(0.1, 0.3, 0.6);
    const float HEIGHT_SCALE = 0.003;
    const float HEIGHT_OFFSET = 0.04;
    const float SKYBLEND_DIST = 1400.0;
    const float SKYBLEND_FACTOR = 0.0003333;

    vec3 getAtmosphereColor(float heightFactor) {
      return mix(LIGHT_BLUE, DEEP_BLUE, heightFactor) * (sunLightIntensity * sunLightIntensity);
    }

    vec3 getSkyboxColor(float viewDirY) {
      float skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
      vec3 skyboxColor = mix(MID_SKY, DAY_SKY, skyFactor);
      vec3 skyDir = -lightDirection;
      if (skyDir.y > 0.0) {
        skyboxColor = mix(skyboxColor, DARK_SKY, skyDir.y * 2.0);
      }
      return skyboxColor;
    }

    vec3 applyDistantFog(vec3 inputColor) {
      vec3 viewVec = vPositionW - cameraPosition;
      float dist = length(viewVec);
      float fogFactor = clamp((vFogInfos.z - dist) / max(vFogInfos.z - vFogInfos.y, 1.0), 0.0, 1.0);

      float heightFactor = clamp((vPositionW.y - dist * HEIGHT_OFFSET) * HEIGHT_SCALE, 0.0, 1.0);
      vec3 atmosphereColor = getAtmosphereColor(heightFactor);
      vec3 baseFogColor = mix(vFogColor, atmosphereColor, 0.8);

      float viewDirY = viewVec.y / max(dist, 1e-4);
      vec3 skyboxColor = getSkyboxColor(viewDirY);

      float skyBlend = clamp((dist - SKYBLEND_DIST) * SKYBLEND_FACTOR, 0.0, 1.0);
      vec3 effectiveFogColor = mix(baseFogColor, skyboxColor, skyBlend);

      return mix(effectiveFogColor, inputColor, fogFactor);
    }

    void main(void) {
      vec2 atlasUV = vUV2 + vUV * atlasTileSize;
      vec4 tex = texture(diffuseTexture, atlasUV);
      if (tex.a < 0.02) {
        discard;
      }

      applyDitherFade();

      float sun = clamp(sunLightIntensity, 0.0, 1.0);
      float skyTerm = vSkyLight * (0.15 + 0.85 * sun);
      float blockTerm = vBlockLight;
      float light = clamp(max(skyTerm, blockTerm), 0.0, 1.0);

      float faceShade = vFaceShade;
      float horizon = clamp(dot(normalize(vFaceNormalW), lightDirection) * 0.5 + 0.5, 0.65, 1.0);
      light = clamp(light * faceShade * horizon, 0.0, 1.0);

      vec3 color = applyTintBucket(tex.rgb, vTintBucket) * light;

      color = applyDistantFog(color);

      fragColor = vec4(color, tex.a);
    }
  `;
}
