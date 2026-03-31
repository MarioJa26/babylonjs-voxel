export class TransparentShader {
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
  flat in float vMaterialType;

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
      mix(hash(i + vec2(0, 0)), hash(i + vec2(1, 0)), u.x),
      mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x),
      u.y
    );
  }

  void main(void) {
    float isWater = vMaterialType;

    // --- 1. Animation ---
    vec2 scrollDir = vec2(-time * 0.3, time * 0.4);
    vec2 animationOffset = scrollDir * isWater;
    vec2 animatedUV = vUV + animationOffset;
    vec2 singleTileUV = fract(animatedUV);

    // --- 2. LOD / UV setup ---
    vec2 dx = dFdx(vUV) * atlasTileSize;
    vec2 dy = dFdy(vUV) * atlasTileSize;
    float lod = log2(max(length(dx), length(dy)));
    vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

    // --- 3. Diffuse sampling ---
    vec4 diffuseColor = textureLod(diffuseTexture, atlasUV, lod);

    // --- 4. Normal selection ---
    vec3 worldNormal;

    if (isWater > 0.5) {
      // Water normal: procedural world-space wave normal only
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
      // Non-water transparent blocks: keep normal atlas path
      vec3 normalMapBase = textureLod(normalTexture, atlasUV, lod).rgb;
      vec3 nonWaterWorldNormal = normalize(vTBN * (normalMapBase * 2.0 - 1.0));
      worldNormal = nonWaterWorldNormal;
    }

    // --- 5. Direct Lighting ---
    float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));
    vec3 diffuse = diffuseColor.rgb * diffuseIntensity * sunLightIntensity;

    vec3 viewDirection = normalize(cameraPosition - vPositionW);
    vec3 halfwayDir = normalize(lightDirection + viewDirection);

    float specPower = mix(16.0, 64.0, isWater);
    float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), specPower);
    float specularIntensity = mix(0.5, 1.8, isWater) * vSkyLight;
    vec3 specular = vec3(specularIntensity) * spec * sunLightIntensity;

    // --- 6. Ambient Occlusion and Environment Light ---
    float aoFactor = 1.0 - vAO * mix(0.1, 0.1, isWater);
    float lightLevel = max(vSkyLight, vBlockLight);

    vec3 vSkyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
    vec3 vBlockColor = vec3(0.9, 0.6, 0.2);
    vec3 lightMix = clamp(
      (vSkyLight * vSkyColor) + (vBlockLight * vBlockColor),
      0.0,
      1.0
    );

    // --- 7. Final Color and Alpha ---
    vec3 litColor = diffuseColor.rgb + diffuse + specular;
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
