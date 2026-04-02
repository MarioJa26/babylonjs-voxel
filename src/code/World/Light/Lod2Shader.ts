export class Lod2Shader {
  static readonly chunkVertexShader = `
    #version 300 es
    precision highp float;

    in vec3 position;
    in vec4 faceDataA; // x,y,z origin, w = axisFace(0..5)
    in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
    in vec4 faceDataC; // x=packedAO, y=light, z=tintBucket, w=meta

    uniform mat4 world;
    uniform mat4 worldViewProjection;
    uniform float atlasTileSize;

    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
    };

    out vec2 vUV;
    flat out vec2 vUV2;
    out vec3 vPositionW;
    out mat3 vTBN;
    flat out float vSkyLight;
    flat out float vBlockLight;
    flat out float vFaceShade;
    flat out float vTintBucket;

    int decodeCorner(int vertexId, int isBackFace, int flip) {
      const int cornerData[4] = int[](
        2840, // isBackFace=0, flip=0: [0,2,1,0,3,2]
        2908, // isBackFace=0, flip=1: [0,3,1,1,3,2]
        3620, // isBackFace=1, flip=0: [0,1,2,0,2,3]
        3700  // isBackFace=1, flip=1: [0,1,3,1,2,3]
      );
      int state = (isBackFace << 1) | flip;
      return (cornerData[state] >> (vertexId * 2)) & 3;
    }

    void decodeAtlasCorner(int axisFace, int corner, out int cornerId, out int swapUV) {
      const int cornerLookup[6] = int[](108, 57, 108, 147, 177, 228);
      cornerId = (cornerLookup[axisFace] >> (corner << 1)) & 3;
      swapUV = int(axisFace < 4);
    }

    void main(void) {
      int axisFace = int(faceDataA.w + 0.5);
      int axis = axisFace >> 1;
      int isBackFace = axisFace & 1;
      int vertexId = int(position.x + 0.5);

      int meta = int(faceDataC.w);
      int flip = meta & 1;

      int corner = decodeCorner(vertexId, isBackFace, flip);

      const float invPosScale = 0.25;
      float faceWidth = faceDataB.x * invPosScale;
      float faceHeight = faceDataB.y * invPosScale;
      float du = (corner == 1 || corner == 2) ? faceWidth : 0.0;
      float dv = (corner >= 2) ? faceHeight : 0.0;

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

      int atlasCornerId;
      int swapUV;
      decodeAtlasCorner(axisFace, corner, atlasCornerId, swapUV);

      float u = (atlasCornerId == 1 || atlasCornerId == 2) ? 1.0 : 0.0;
      float v = (atlasCornerId >= 2) ? 1.0 : 0.0;

      float uDim = swapUV == 1 ? faceHeight : faceWidth;
      float vDim = swapUV == 1 ? faceWidth : faceHeight;
      vUV = vec2(u, v) * vec2(uDim, vDim);

      vec3 faceOrigin = faceDataA.xyz * invPosScale;
      float uvOffU = fract(faceOrigin[uAxis]);
      float uvOffV = fract(faceOrigin[vAxis]);
      vUV += vec2(
        swapUV == 1 ? uvOffV : uvOffU,
        swapUV == 1 ? uvOffU : uvOffV
      );

      float maxTiles = floor(1.0 / atlasTileSize + 0.5);
      vUV2 = vec2(faceDataB.z, maxTiles - 1.0 - faceDataB.w) * atlasTileSize;
      vTintBucket = faceDataC.z;

      vPositionW = (world * vec4(localPosition, 1.0)).xyz;

      vec3 normal = vec3(0.0);
      if (axis == 0) normal.x = isBackFace == 1 ? -1.0 : 1.0;
      else if (axis == 1) normal.y = isBackFace == 1 ? -1.0 : 1.0;
      else normal.z = isBackFace == 1 ? -1.0 : 1.0;

      vec3 N = normalize(mat3(world) * normal);

      float isX = axis == 0 ? 1.0 : 0.0;
      float isY = axis == 1 ? 1.0 : 0.0;
      vec3 tObj = vec3(1.0 - isX - isY, isX, isY);

      float handedness = sign(normal.x + normal.y + normal.z);
      vec3 T = normalize(mat3(world) * tObj);
      vec3 B = normalize(cross(N, T) * handedness);
      vTBN = mat3(T, B, N);

      int light = int(faceDataC.y);
      vSkyLight = float(light >> 4) * 0.0666666;
      vBlockLight = float(light & 0xF) * 0.0666666;

      // AO impostor by face axis:
      // top=1.0, side=0.78, bottom=0.58
      if (axis == 1) {
        vFaceShade = isBackFace == 1 ? 0.58 : 1.0;
      } else {
        vFaceShade = 0.78;
      }
    }
  `;

  static readonly opaqueFragmentShader = `
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

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
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

      vec2 singleTileUV = fract(vUV);
      vec2 dx = dFdx(vUV) * atlasTileSize;
      vec2 dy = dFdy(vUV) * atlasTileSize;
      float lod = log2(max(length(dx), length(dy)));
      vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

      vec4 diffuseColor = textureLod(diffuseTexture, atlasUV, lod);
      diffuseColor.rgb *= mix(1.0, 0.55, wetness);

      vec3 normalMap = textureLod(normalTexture, atlasUV, lod).rgb;
      normalMap = normalize(normalMap * 2.0 - 1.0);
      vec3 worldNormal = normalize(vTBN * normalMap);

      float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));
      vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

      vec3 viewDirection = normalize(cameraPosition - vPositionW);
      vec3 halfwayDir = normalize(viewDirection + lightDirection);
      float shininess = mix(16.0, 96.0, wetness);
      float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), shininess);

      float specIntensity = mix(0.03, 1.2, wetness) * vSkyLight;
      vec3 specular = vec3(specIntensity) * spec * max(sunLightIntensity - 0.1, 0.0);

      vec3 skyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
      vec3 blockColor = vec3(0.9, 0.6, 0.2);
      vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.18, 1.0);

      float horizon = clamp(dot(worldNormal, lightDirection) * 0.5 + 0.5, 0.65, 1.0);
      float faceShade = vFaceShade;

      vec3 color = (diffuseColor.rgb + diffuse + specular) * lightMix * horizon * faceShade;
      color = applyTintBucket(color, vTintBucket);

      color = applyDistantFog(color);

      fragColor = vec4(color, diffuseColor.a);
    }
  `;

  static readonly transparentFragmentShader = `
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

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
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
      vec2 singleTileUV = fract(vUV);
      vec2 dx = dFdx(vUV) * atlasTileSize;
      vec2 dy = dFdy(vUV) * atlasTileSize;
      float lod = log2(max(length(dx), length(dy)));
      vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

      vec4 diffuseColor = textureLod(diffuseTexture, atlasUV, lod);
      if (diffuseColor.a < 0.02) {
        discard;
      }
      applyDitherFade();

      diffuseColor.rgb *= mix(1.0, 0.55, wetness);

      vec3 normalMap = textureLod(normalTexture, atlasUV, lod).rgb;
      normalMap = normalize(normalMap * 2.0 - 1.0);
      vec3 worldNormal = normalize(vTBN * normalMap);

      float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));
      vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

      vec3 viewDirection = normalize(cameraPosition - vPositionW);
      vec3 halfwayDir = normalize(viewDirection + lightDirection);
      float shininess = mix(16.0, 96.0, wetness);
      float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), shininess);

      float specIntensity = mix(0.03, 1.2, wetness) * vSkyLight;
      vec3 specular = vec3(specIntensity) * spec * max(sunLightIntensity - 0.1, 0.0);

      vec3 skyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
      vec3 blockColor = vec3(0.9, 0.6, 0.2);
      vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.18, 1.0);

      float horizon = clamp(dot(worldNormal, lightDirection) * 0.5 + 0.5, 0.65, 1.0);
      float faceShade = vFaceShade;

      vec3 color = (diffuseColor.rgb + diffuse + specular) * lightMix * horizon * faceShade;
      color = applyTintBucket(color, vTintBucket);

      color = applyDistantFog(color);

      fragColor = vec4(color, diffuseColor.a);
    }
  `;
}
