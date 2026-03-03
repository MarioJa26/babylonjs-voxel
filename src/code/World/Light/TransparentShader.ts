export class TransparentShader {
  public static readonly chunkFragmentShader = `
    precision highp float;
    #extension GL_OES_standard_derivatives : enable
    #extension GL_EXT_shader_texture_lod : enable

    varying vec3 vPositionW;
    varying vec2 vUV;
    varying vec2 vUV2;
    varying mat3 vTBN;
    varying float vAO;
    varying float vSkyLight;
    varying float vBlockLight;
    varying float vMaterialType; 

    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float atlasTileSize;
    uniform float time; 
    uniform float sunLightIntensity;
    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;

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
        vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
        vec3 normalMap = texture2DLodEXT(normalTexture, atlasUV, lod).rgb;
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
        
        // FIX: Scale sky light color by sunLightIntensity so ambient light disappears at night
        vec3 skyColor = vec3(0.6, 0.8, 1.0) * (sunLightIntensity + 0.05); 
        vec3 blockColor = vec3(1.0, 0.6, 0.2); 
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);

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

        gl_FragColor = vec4(finalColor, alpha);
    }
  `;
}
