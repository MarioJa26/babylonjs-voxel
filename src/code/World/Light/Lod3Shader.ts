export const LOD3chunkVertexShader = `
    #version 300 es
    precision highp float;

    in vec3 position;
    in vec4 faceDataA; // x,y,z origin, w = axisFace(0..5)
    in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
    in vec4 faceDataC; // x=packedAO (unused), y=light, z=tintBucket, w=meta
    in float chunkIndex;

    uniform mat4 world;
    uniform mat4 worldViewProjection;
    uniform float atlasTileSize;
    uniform float atlasMaxTiles;
    uniform vec3 chunkOffsets[64];

    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
      vec4 vFogInfos;
      vec3 vFogColor;
    };

    out vec2 vUV;
    flat out vec2 vUV2;
    flat out float vSkyLight;
    flat out float vBlockLight;
    flat out float vFaceShade;
    flat out vec3 vFaceNormalW;
    flat out float vTintBucket;
    out vec3 vPositionW;

    out float vFogFactor;
    out vec3 vFogColorCheap;

    vec2 cornerToUV(int corner) {
      return vec2(float((corner ^ (corner >> 1)) & 1), float(corner >> 1));
    }

    const int U_AXIS[3] = int[](1, 2, 0);
    const int V_AXIS[3] = int[](2, 0, 1);

    void main(void) {
      int axisFace = int(faceDataA.w + 0.5);
      int axis = axisFace >> 1;
      int isBackFace = axisFace & 1;
      int vertexId = int(position.x + 0.5);

      const int cornerData[2] = int[](
        228, // isBackFace=0, flip=0: [0,1,2,3]
        198  // isBackFace=1, flip=0: [2,1,0,3]
      );
      int corner = (cornerData[isBackFace] >> (vertexId << 1)) & 3;

      int meta = int(faceDataC.w + 0.5);
      const float invPosScale = 0.125;
      int rawDim = (meta >> 6) & 1;
      float faceWidth = rawDim == 1 ? float(faceDataB.x) : faceDataB.x * invPosScale;
      float faceHeight = rawDim == 1 ? float(faceDataB.y) : faceDataB.y * invPosScale;

      vec2 cornerUV = cornerToUV(corner);
      float du = cornerUV.x * faceWidth;
      float dv = cornerUV.y * faceHeight;

      int uAxis = U_AXIS[axis];
      int vAxis = V_AXIS[axis];

      vec3 localPosition = faceDataA.xyz * invPosScale;
      localPosition[uAxis] += du;
      localPosition[vAxis] += dv;

      localPosition += chunkOffsets[int(chunkIndex + 0.5)];

      gl_Position = worldViewProjection * vec4(localPosition, 1.0);
      vPositionW = localPosition + world[3].xyz;

      vUV = cornerUV;

      vUV2 = vec2(faceDataB.z, atlasMaxTiles - 1.0 - faceDataB.w) * atlasTileSize;

      int light = int(faceDataC.y);
      vSkyLight = float((light >> 4) & 0xF) * (1.0 / 15.0);
      vBlockLight = float(light & 0xF) * (1.0 / 15.0);
      vTintBucket = faceDataC.z;

      vec3 normal = vec3(0.0);
      normal[axis] = isBackFace == 1 ? -1.0 : 1.0;
      vFaceNormalW = normal;

      if (axis == 1) {
        vFaceShade = isBackFace == 1 ? 0.58 : 1.0;
      } else {
        vFaceShade = 0.78;
      }

      // Fog computed per-vertex (matches LOD2 approach)
      vec3 viewVec = vPositionW - cameraPosition;
      float dist = length(viewVec);

      vFogFactor = clamp(
        (vFogInfos.z - dist) / max(vFogInfos.z - vFogInfos.y, 1.0),
        0.0, 1.0
      );

      float heightFactor = clamp(
        (vPositionW.y - dist * 0.04) * 0.003,
        0.0, 1.0
      );

      vec3 atmosphereColor = mix(
        vec3(0.6, 0.75, 0.95), vec3(0.1, 0.2, 0.4), heightFactor
      ) * (sunLightIntensity * sunLightIntensity);

      vec3 viewDir = viewVec / max(dist, 1e-4);
      float skyFactor = smoothstep(0.0, 0.4, max(viewDir.y, 0.0));
      vec3 skyboxColor = mix(vec3(0.5, 0.7, 0.9), vec3(0.1, 0.3, 0.6), skyFactor);

      vec3 skyDir = -lightDirection;
      if (skyDir.y > 0.0) {
        skyboxColor = mix(skyboxColor, vec3(0.1, 0.1, 0.2), skyDir.y * 2.0);
      }

      vec3 baseFogColor = mix(vFogColor, atmosphereColor, 0.8);
      float skyBlend = clamp((dist - 1400.0) * 0.0003333, 0.0, 1.0);
      vFogColorCheap = mix(baseFogColor, skyboxColor, skyBlend);
    }
  `;

export const LOD3OpaqueFragmentShader = `
    #version 300 es
    precision highp float;

    in vec2 vUV;
    flat in vec2 vUV2;
    flat in float vSkyLight;
    flat in float vBlockLight;
    flat in float vFaceShade;
    flat in vec3 vFaceNormalW;
    flat in float vTintBucket;
    in vec3 vPositionW;

    in float vFogFactor;
    in vec3 vFogColorCheap;

    uniform sampler2D diffuseTexture;
    uniform float atlasTileSize;
    uniform float lodFadeProgress;
    uniform float lodFadeDirection;
    uniform float lodFadeSeed;
    uniform vec4 tintLUT[6];

    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
      vec4 vFogInfos;
      vec3 vFogColor;
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
      int idx = int(min(floor(bucket + 0.5), 5.0));
      float lum = dot(color, vec3(0.299, 0.587, 0.114));
      return mix(vec3(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
    }

    void main(void) {
      applyDitherFade();

      vec2 atlasUV = vUV2 + vUV * atlasTileSize;
      vec4 tex = texture(diffuseTexture, atlasUV);

      float sun = clamp(sunLightIntensity, 0.0, 1.0);
      float skyTerm = vSkyLight * (0.15 + 0.85 * sun);
      float blockTerm = vBlockLight;

      float faceShade = vFaceShade;
      float horizon = clamp(dot(vFaceNormalW, lightDirection) * 0.5 + 0.5, 0.65, 1.0);
      float light = clamp(max(skyTerm * faceShade * horizon, blockTerm), 0.0, 1.0);

      vec3 color = applyTintBucket(tex.rgb, vTintBucket) * light;

      color = mix(vFogColorCheap, color, vFogFactor);

      fragColor = vec4(color, 1.0);
    }
  `;

export const LOD3transparentFragmentShader = `
    #version 300 es
    precision highp float;

    in vec2 vUV;
    flat in vec2 vUV2;
    flat in float vSkyLight;
    flat in float vBlockLight;
    flat in float vFaceShade;
    flat in vec3 vFaceNormalW;
    flat in float vTintBucket;
    in vec3 vPositionW;

    in float vFogFactor;
    in vec3 vFogColorCheap;

    uniform sampler2D diffuseTexture;
    uniform float atlasTileSize;
    uniform float lodFadeProgress;
    uniform float lodFadeDirection;
    uniform float lodFadeSeed;
    uniform vec4 tintLUT[6];

    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
      vec4 vFogInfos;
      vec3 vFogColor;
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
      int idx = int(min(floor(bucket + 0.5), 5.0));
      float lum = dot(color, vec3(0.299, 0.587, 0.114));
      return mix(vec3(lum), color, tintLUT[idx].a) * tintLUT[idx].rgb;
    }

    void main(void) {
      applyDitherFade();

      vec2 atlasUV = vUV2 + vUV * atlasTileSize;
      vec4 tex = texture(diffuseTexture, atlasUV);

      if (tex.a < 0.02) {
        discard;
      }

      float sun = clamp(sunLightIntensity, 0.0, 1.0);
      float skyTerm = vSkyLight * (0.15 + 0.85 * sun);
      float blockTerm = vBlockLight;

      float faceShade = vFaceShade;
      float horizon = clamp(dot(vFaceNormalW, lightDirection) * 0.5 + 0.5, 0.65, 1.0);
      float light = clamp(max(skyTerm * faceShade * horizon, blockTerm), 0.0, 1.0);

      vec3 color = applyTintBucket(tex.rgb, vTintBucket) * light;

      color = mix(vFogColorCheap, color, vFogFactor);

      fragColor = vec4(color, tex.a);
    }
  `;
