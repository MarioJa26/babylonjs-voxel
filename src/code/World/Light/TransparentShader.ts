export class TransparentShader {
	public static readonly chunkVertexShader = `
    #version 300 es
    precision highp float;

    // Attributes
    in vec3 position;
    in vec4 faceDataA; // x,y,z origin/center, w = axisFace(0..5)
    in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
    in vec4 faceDataC; // x=packedAO, y=light, z=tint, w=meta
    in float chunkIndex;

    // Uniforms
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
    };

    // Varyings
    out vec2 vUV;
    flat out vec2 vUV2;
    out vec3 vPositionW;
    out mat3 vTBN;
    out float vAO;
    flat out float vSkyLight;
    flat out float vBlockLight;
    flat out float vIsWater;
    out vec3 vViewDir;

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

    void buildDiagonalQuad(
      vec3 centerBottom,
      float width,
      float height,
      int diagonalVariant,
      bool isBackFace,
      vec2 cornerUV,
      out vec3 outPosition,
      out vec3 outNormal,
      out vec3 outTangent,
      out vec3 outBitangent
    ) {
      const vec2 DIR_XZ[2] = vec2[](
        vec2(0.70710678, 0.70710678),
        vec2(0.70710678, -0.70710678)
      );
      vec2 dirXZ = DIR_XZ[diagonalVariant];

      vec3 tangent = vec3(dirXZ.x, 0.0, dirXZ.y);
      vec3 bitangent = vec3(0.0, 1.0, 0.0);

      const vec3 DIAG_NORMALS[2] = vec3[](
        vec3(0.70710678, 0.0, -0.70710678),
        vec3(-0.70710678, 0.0, -0.70710678)
      );
      vec3 normal = DIAG_NORMALS[diagonalVariant];

      if (isBackFace) {
        normal = -normal;
      }

      vec3 bottomA = centerBottom - tangent * (width * 0.5);
      vec3 bottomB = centerBottom + tangent * (width * 0.5);
      vec3 topA = bottomA + bitangent * height;
      vec3 topB = bottomB + bitangent * height;

      vec3 edgeBottom = mix(bottomA, bottomB, cornerUV.x);
      vec3 edgeTop = mix(topA, topB, cornerUV.x);
      outPosition = mix(edgeBottom, edgeTop, cornerUV.y);

      outNormal = normal;
      outTangent = tangent;
      outBitangent = bitangent;
    }

    void main(void) {
      int axisFace = int(faceDataA.w + 0.5);
      int axis = axisFace >> 1;
      int isBackFaceInt = axisFace & 1;
      bool isBackFace = isBackFaceInt == 1;
      int vertexId = int(position.x + 0.5);

      int meta = int(faceDataC.w + 0.5);
      int flip = meta & 1;

      int isWater = (meta >> 3) & 1;
      bool diagonalEnabled = ((meta >> 4) & 1) != 0;
      int diagonalVariant = (meta >> 5) & 1;

      int corner = decodeCorner(vertexId, isBackFaceInt, flip);
      vec2 cornerUV = getQuadCornerUV(corner);

      const float invPosScale = 0.125;
      int rawDim = (meta >> 6) & 1;
      float faceWidth = rawDim == 1 ? float(faceDataB.x) : faceDataB.x * invPosScale;
      float faceHeight = rawDim == 1 ? float(faceDataB.y) : faceDataB.y * invPosScale;

      vec3 localPosition;
      vec3 N;
      vec3 T;
      vec3 B;

      if (diagonalEnabled) {
        vec3 centerBottom = faceDataA.xyz * invPosScale;

        buildDiagonalQuad(
          centerBottom,
          faceWidth,
          faceHeight,
          diagonalVariant,
          isBackFace,
          cornerUV,
          localPosition,
          N,
          T,
          B
        );

        vUV = cornerUV;
      } else {
        float du = float((corner ^ (corner >> 1)) & 1) * faceWidth;
        float dv = float(corner >> 1) * faceHeight;

        int uAxis = (axis + 1) % 3;
        int vAxisLocal = (axis + 2) % 3;

        localPosition = faceDataA.xyz * invPosScale;
        localPosition[uAxis] += du;
        localPosition[vAxisLocal] += dv;

        int atlasCornerId;
        int swapUV;
        decodeAtlasCorner(axisFace, corner, atlasCornerId, swapUV);

        float u = float((atlasCornerId ^ (atlasCornerId >> 1)) & 1);
        float v = float(atlasCornerId >> 1);

        float uDim = swapUV == 1 ? faceHeight : faceWidth;
        float vDim = swapUV == 1 ? faceWidth : faceHeight;
        vUV = vec2(u, v) * vec2(uDim, vDim);

        vec3 faceOrigin = faceDataA.xyz * invPosScale;
        vec2 uvOff = vec2(fract(faceOrigin[uAxis]), fract(faceOrigin[vAxisLocal]));
        vUV += swapUV == 1 ? uvOff.yx : uvOff;

        float fSign = isBackFace ? -1.0 : 1.0;
        vec3 normal = vec3(0.0);
        normal[axis] = fSign;

        N = normal;

        vec3 tObj = vec3(0.0);
        tObj[uAxis] = 1.0;

        T = tObj;
        B = cross(N, T) * fSign;
      }

      localPosition += chunkOffsets[int(chunkIndex + 0.5)];

      gl_Position = worldViewProjection * vec4(localPosition, 1.0);

      vUV2 = vec2(faceDataB.z, atlasMaxTiles - 1.0 - faceDataB.w) * atlasTileSize;

      vPositionW = localPosition + world[3].xyz;
      vTBN = mat3(T, B, N);
      vViewDir = normalize(cameraPosition - vPositionW);

      int packedAO = int(faceDataC.x + 0.5);
      vAO = float((packedAO >> (corner << 1)) & 3);

      int light = int(faceDataC.y + 0.5);
      vSkyLight = float((light >> 4) & 0xF) * (1.0 / 15.0);
      vBlockLight = float(light & 0xF) * (1.0 / 15.0);

      vIsWater = float(isWater);
    }
  `;

	public static readonly chunkFragmentShader = `
  #version 300 es
  precision highp float;

  in vec3 vPositionW;
  in vec2 vUV;
  flat in vec2 vUV2;
  in mat3 vTBN;
  in float vAO;
  flat in float vSkyLight;
  flat in float vBlockLight;
  flat in float vIsWater;
  in vec3 vViewDir;

  uniform float atlasTileSize;
  uniform sampler2D diffuseTexture;
  uniform sampler2D normalTexture;

  uniform GlobalUniforms {
    vec3 lightDirection; // pre-normalized on CPU
    vec3 cameraPosition;
    float sunLightIntensity;
    float wetness;
    float time;
  };

  out vec4 fragColor;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main(void) {
    float isWater = step(0.5, vIsWater);

    // --- 1. Animation ---
    vec2 scrollDir = vec2(-time * 0.3, time * 0.4);
    vec2 animationOffset = scrollDir * isWater;
    vec2 animatedUV = vUV + animationOffset;
    vec2 singleTileUV = fract(animatedUV);

    // --- 2. UV setup ---
    vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

    // --- 3. Diffuse sampling ---
    vec4 diffuseColor = texture(diffuseTexture, atlasUV);

    // Early alpha discard — skips water noise + all lighting for fully transparent fragments.
    if (diffuseColor.a < 0.01) discard;

    // --- 4. Normal selection ---
    vec3 worldNormal;

    if (isWater > 0.5) {
      // Procedural water wave normal
      vec2 wavePos = vPositionW.xz * 0.3 + scrollDir;
      vec2 wavePosB = wavePos * 1.314 + 4.7;

      float eps = 0.05;
      vec2 epsDX = vec2(eps, 0.0);
      vec2 epsDZ = vec2(0.0, eps);

      float wC = valueNoise(wavePos) + valueNoise(wavePosB);
      float wCDX = valueNoise(wavePos + epsDX) + valueNoise(wavePosB + epsDX);
      float wCDZ = valueNoise(wavePos + epsDZ) + valueNoise(wavePosB + epsDZ);

      float waveStrength = 0.15;

      worldNormal = normalize(vec3(
        -(wCDX - wC) / eps * waveStrength,
        1.0,
        -(wCDZ - wC) / eps * waveStrength
      ));
    } else {
      vec3 normalMapBase = texture(normalTexture, atlasUV).rgb;
      worldNormal = normalize(vTBN * (normalMapBase * 2.0 - 1.0));
    }

    // --- 5. Direct Lighting ---
    float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

    // Cheap Blinn-Phong: pow(NdotH, s) ≈ exp2(-s * 1.4427 * (1 - NdotH))
    vec3 halfwayDir = normalize(vViewDir + lightDirection);

    float specPower = mix(16.0, 64.0, isWater);
    float NH = max(dot(worldNormal, halfwayDir), 0.0);
    float spec = exp2(clamp(specPower * 1.4427 * (NH - 1.0), -126.0, 0.0));
    float specularIntensity = mix(0.5, 1.8, isWater) * vSkyLight;
    vec3 specular = vec3(specularIntensity) * spec * sunLightIntensity;

    // --- 6. Ambient Occlusion and Environment Light ---
    float aoFactor = 1.0 - vAO * 0.1;
    float lightLevel = max(vSkyLight, vBlockLight);

    float skyScale = vSkyLight * 0.8 * (sunLightIntensity + 0.2);
    vec3 lightMix = clamp(
      skyScale + vBlockLight * vec3(0.9, 0.6, 0.2),
      0.0,
      1.0
    );

    // --- 7. Final Color and Alpha ---
    vec3 litColor = diffuseColor.rgb * (1.0 + diffuseIntensity * sunLightIntensity) + specular;
    float luminance = dot(litColor, vec3(0.299, 0.587, 0.114));
    float saturation = mix(1.0, 0.5, isWater);
    litColor = mix(
      vec3(luminance),
      litColor,
      lightLevel * saturation + (1.0 - saturation)
    );

    vec3 finalColor =
      litColor * max(lightMix * aoFactor, mix(0.02, 0.08, isWater));

    float baseAlpha = diffuseColor.a;
    float alpha = baseAlpha * mix(1.0, mix(0.9, 0.4, lightLevel), isWater);

    fragColor = vec4(finalColor, alpha);
  }
  `;
}
