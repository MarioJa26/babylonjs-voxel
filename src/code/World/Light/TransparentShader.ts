export class TransparentShader {
  public static readonly chunkFragmentShader = `
    #version 300 es
    precision highp float;

    in vec3 vPositionW;
    in vec2 vUV;
    in vec2 vUV2;
    in mat3 vTBN;
    in float vAO;
    in float vSkyLight;
    in float vBlockLight;
    in float vMaterialType; 
    in vec3 vSkyColor;
    in vec3 vBlockColor;

    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float atlasTileSize;
    uniform float time; 
    uniform float sunLightIntensity;
    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;

    out vec4 fragColor;

    void main(void) {
        float isWater = vMaterialType; 
        
        // --- 1. Animation ---
        vec2 animationOffset = vec2(-time * 0.3, time * 0.4) * isWater;
        vec2 animatedUV = vUV + animationOffset;
        vec2 singleTileUV = fract(animatedUV);

        // --- 2. LOD Calculation ---
        vec2 dx = dFdx(vUV) * atlasTileSize;
        vec2 dy = dFdy(vUV) * atlasTileSize;
        float lod = log2(max(length(dx), length(dy)));
        vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

        // --- 3. Sampling ---
        vec4 diffuseColor = textureLod(diffuseTexture, atlasUV, lod);
        vec3 normalMap = textureLod(normalTexture, atlasUV, lod).rgb;
        normalMap = normalize(normalMap * 2.0 - 1.0);
        vec3 worldNormal = normalize(vTBN * normalMap);

        // --- 4. Direct Lighting ---
        vec3 normalizedLightDirection = normalize(lightDirection);
        float diffuseIntensity = max(0.0, dot(worldNormal, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity * sunLightIntensity;

        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(normalizedLightDirection + viewDirection);
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 16.0);

        // Specular is muted by both sun intensity and sky light level
        float specularIntensity = 0.5 * vSkyLight; 
        vec3 specular = vec3(specularIntensity) * spec * sunLightIntensity;

        // --- 5. Ambient Occlusion and Environment Light ---
        float aoFactor = 1.0 - vAO * mix(0.1, 0.24, isWater); 
        float lightLevel = max(vSkyLight, vBlockLight);
        
        vec3 lightMix = clamp((vSkyLight * vSkyColor) + (vBlockLight * vBlockColor), 0.0, 1.0);

        // --- 6. Final Color and Alpha ---
        vec3 litColor = diffuseColor.rgb + diffuse + specular;

        // Desaturate in low light
        float luminance = dot(litColor, vec3(0.299, 0.587, 0.114));
        float saturation = mix(1.0, 0.5, isWater); 
        litColor = mix(vec3(luminance), litColor, lightLevel * saturation + (1.0 - saturation));

        // FIX: Lowered the minimum brightness (0.02 for glass) to prevent glowing in the dark
        // Also replaced the hardcoded 1.0 with isWater
        vec3 finalColor = litColor * max(lightMix * aoFactor, mix(0.02, 0.08, isWater));

        float baseAlpha = diffuseColor.a;
        float alpha = baseAlpha * mix(1.0, mix(0.9, 0.4, lightLevel), isWater);

        fragColor = vec4(finalColor, alpha);
    }
  `;
}
