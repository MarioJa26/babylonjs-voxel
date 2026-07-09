export namespace Lod2Shader {
	export const chunkVertexShader = `
    #version 300 es
    precision highp float;

    in vec3 position;
    in vec4 faceDataA; // x,y,z origin, w = axisFace(0..5)
    in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
    in vec4 faceDataC; // x=packedAO, y=light, z=tintBucket, w=meta
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
    out vec3 vPositionW;
    out mat3 vTBN;
    flat out float vSkyLight;
    flat out float vBlockLight;
    flat out float vFaceShade;
    flat out float vTintBucket;

    out float vFogFactor;
    out vec3 vFogColorCheap;

    int decodeCorner(int vertexId, int isBackFace, int flip) {
      const int cornerData[4] = int[](
        228, // isBackFace=0, flip=0: [0,1,2,3]
        147, // isBackFace=0, flip=1: [3,0,1,2]
        198, // isBackFace=1, flip=0: [2,1,0,3]
        177  // isBackFace=1, flip=1: [1,0,3,2]
      );
      int state = (isBackFace << 1) | flip;
      return (cornerData[state] >> (vertexId << 1)) & 3;
    }

    void decodeAtlasCorner(int axisFace, int corner, out int cornerId, out int swapUV) {
      const int cornerLookup[6] = int[](108, 57, 108, 147, 177, 228);
      cornerId = (cornerLookup[axisFace] >> (corner << 1)) & 3;
      swapUV = int(axisFace < 4);
    }

    vec2 getQuadCornerUV(int i) {
      return vec2(float((i ^ (i >> 1)) & 1), float(i >> 1));
    }

    const mat3 TBN_TABLE[6] = mat3[](
        mat3(0,1,0, 0,0,1, 1,0,0),   // 0: +X
        mat3(0,1,0, 0,0,1, -1,0,0),  // 1: -X
        mat3(0,0,1, 1,0,0, 0,1,0),   // 2: +Y
        mat3(0,0,1, 1,0,0, 0,-1,0),  // 3: -Y
        mat3(1,0,0, 0,1,0, 0,0,1),   // 4: +Z
        mat3(1,0,0, 0,1,0, 0,0,-1)   // 5: -Z
    );

      const int U_AXIS[3] = int[](1, 2, 0);
      const int V_AXIS[3] = int[](2, 0, 1);

    void main(void) {
      int axisFace = int(faceDataA.w + 0.5);
      int axis = axisFace >> 1;
      int isBackFace = axisFace & 1;
      int vertexId = int(position.x + 0.5);

      int meta = int(faceDataC.w);
      int flip = meta & 1;

      int corner = decodeCorner(vertexId, isBackFace, flip);

      const float invPosScale = 0.125;
      int rawDim = (meta >> 6) & 1;
      float faceWidth = rawDim == 1 ? float(faceDataB.x) : faceDataB.x * invPosScale;
      float faceHeight = rawDim == 1 ? float(faceDataB.y) : faceDataB.y * invPosScale;

      vec2 cornerUV = getQuadCornerUV(corner);
      float du = cornerUV.x * faceWidth;
      float dv = cornerUV.y * faceHeight;


      int uAxis = U_AXIS[axis];
      int vAxis = V_AXIS[axis];

      vec3 localPosition = faceDataA.xyz * invPosScale;
      localPosition[uAxis] += du;
      localPosition[vAxis] += dv;

      localPosition += chunkOffsets[int(chunkIndex + 0.5)];

      gl_Position = worldViewProjection * vec4(localPosition, 1.0);

      int atlasCornerId;
      int swapUV;
      decodeAtlasCorner(axisFace, corner, atlasCornerId, swapUV);

      float u = float((atlasCornerId ^ (atlasCornerId >> 1)) & 1);
      float v = float(atlasCornerId >> 1);

      float uDim = swapUV == 1 ? faceHeight : faceWidth;
      float vDim = swapUV == 1 ? faceWidth : faceHeight;
      vUV = vec2(u, v) * vec2(uDim, vDim);

      vec3 faceOrigin = faceDataA.xyz * invPosScale;
      vec2 uvOff = vec2(fract(faceOrigin[uAxis]), fract(faceOrigin[vAxis]));
      vUV += swapUV == 1 ? uvOff.yx : uvOff;

      vUV2 = vec2(faceDataB.z, atlasMaxTiles - 1.0 - faceDataB.w) * atlasTileSize;
      vTintBucket = faceDataC.z;

      vPositionW = localPosition + world[3].xyz;

      mat3 tbn = TBN_TABLE[axisFace];
      vTBN = tbn;

      int light = int(faceDataC.y);
      vSkyLight = float((light >> 4) & 0xF) * (1.0 / 15.0);
      vBlockLight = float(light & 0xF) * (1.0 / 15.0);

      // AO impostor by face axis:
      // top=1.0, side=0.78, bottom=0.58
      if (axis == 1) {
        vFaceShade = isBackFace == 1 ? 0.58 : 1.0;
      } else {
        vFaceShade = 0.78;
      }

      // Fog moved from fragment to vertex
      vec3 viewVec = vPositionW - cameraPosition;
      float dist = length(viewVec);

      vFogFactor = clamp(
        (vFogInfos.z - dist) / max(vFogInfos.z - vFogInfos.y, 1.0),
        0.0,
        1.0
      );

      float heightFactor = clamp(
        (vPositionW.y - dist * 0.04) * 0.003,
        0.0,
        1.0
      );

      vec3 atmosphereColor =
        mix(vec3(0.6, 0.75, 0.95), vec3(0.1, 0.2, 0.4), heightFactor) *
        (sunLightIntensity * sunLightIntensity);

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

	export const opaqueFragmentShader = `
    #version 300 es
    precision highp float;

    in vec2 vUV;
    flat in vec2 vUV2;
    in vec3 vPositionW;
    in mat3 vTBN;
    flat in float vSkyLight;
    flat in float vBlockLight;
    flat in float vFaceShade;
    flat in float vTintBucket;

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

      vec2 singleTileUV = fract(vUV);
      vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

      vec4 diffuseColor = texture(diffuseTexture, atlasUV);

      if (diffuseColor.a < 0.01) discard;

      diffuseColor.rgb *= mix(1.0, 0.55, wetness);

      vec3 worldNormal = vTBN[2];

      float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

      // Cheap Blinn-Phong: pow(NdotH, s) ≈ exp2(-s * 1.4427 * (1 - NdotH))
      vec3 viewDirection = cameraPosition - vPositionW;
      vec3 halfwayDir = normalize(viewDirection + lightDirection);
      float shininess = mix(16.0, 96.0, wetness);
      float NH = max(dot(worldNormal, halfwayDir), 0.0);
      float spec = exp2(clamp(shininess * 1.4427 * (NH - 1.0), -126.0, 0.0));

      float specIntensity = mix(0.03, 1.2, wetness) * vSkyLight;
      vec3 specular = vec3(specIntensity) * spec * max(sunLightIntensity - 0.1, 0.0);

      float skyScale = vSkyLight * 0.8 * (sunLightIntensity + 0.2);
      vec3 lightMix = clamp(skyScale + vBlockLight * vec3(0.9, 0.6, 0.2), 0.18, 1.0);

      float horizon = clamp(dot(worldNormal, lightDirection) * 0.5 + 0.5, 0.65, 1.0);
      float faceShade = vFaceShade;

      vec3 color = (diffuseColor.rgb * (1.0 + diffuseIntensity * sunLightIntensity) + specular) * lightMix * horizon * faceShade;
      color = applyTintBucket(color, vTintBucket);

      // Fog now uses interpolated vertex result
      color = mix(vFogColorCheap, color, vFogFactor);

      fragColor = vec4(color, diffuseColor.a);
    }
  `;

	export const transparentFragmentShader = `
    #version 300 es
    precision highp float;

    in vec2 vUV;
    flat in vec2 vUV2;
    in vec3 vPositionW;
    in mat3 vTBN;
    flat in float vSkyLight;
    flat in float vBlockLight;
    flat in float vFaceShade;
    flat in float vTintBucket;

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
      vec2 singleTileUV = fract(vUV);
      vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

      vec4 diffuseColor = texture(diffuseTexture, atlasUV);
      applyDitherFade();
      if (diffuseColor.a < 0.02) {
        discard;
      }

      diffuseColor.rgb *= mix(1.0, 0.55, wetness);

      vec3 worldNormal = vTBN[2];

      float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

      vec3 viewDirection = cameraPosition - vPositionW;
      vec3 halfwayDir = normalize(viewDirection + lightDirection);
      float shininess = mix(16.0, 96.0, wetness);
      float NH = max(dot(worldNormal, halfwayDir), 0.0);
      float spec = exp2(clamp(shininess * 1.4427 * (NH - 1.0), -126.0, 0.0));

      float specIntensity = mix(0.03, 1.2, wetness) * vSkyLight;
      vec3 specular = vec3(specIntensity) * spec * max(sunLightIntensity - 0.1, 0.0);

      float skyScale = vSkyLight * 0.8 * (sunLightIntensity + 0.2);
      vec3 lightMix = clamp(skyScale + vBlockLight * vec3(0.9, 0.6, 0.2), 0.18, 1.0);

      float horizon = clamp(dot(worldNormal, lightDirection) * 0.5 + 0.5, 0.65, 1.0);
      float faceShade = vFaceShade;

      vec3 color = (diffuseColor.rgb * (1.0 + diffuseIntensity * sunLightIntensity) + specular) * lightMix * horizon * faceShade;
      color = applyTintBucket(color, vTintBucket);

      // Fog now uses interpolated vertex result
      color = mix(vFogColorCheap, color, vFogFactor);

      fragColor = vec4(color, diffuseColor.a);
    }
  `;
}
