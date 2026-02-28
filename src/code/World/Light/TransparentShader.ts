export class TransparentShader {
  public static chunkFragmentShader = `
    precision highp float;
    #extension GL_OES_standard_derivatives : enable
    #extension GL_EXT_shader_texture_lod : enable

    // Varyings
    varying vec3 vPositionW;
    varying vec2 vUV;
    varying vec2 vUV2;
    varying vec2 vUV3;
    varying mat3 vTBN;
    varying float vAO;
    varying float vSkyLight;
    varying float vBlockLight;
    varying float vMaterialType; // 0 = glass, 1 = water

    // Uniforms
    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float atlasTileSize;
    uniform float time; // Time in seconds for animation (for water only)
    uniform float sunLightIntensity;

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;

    void main(void) {
        // Use material type directly from vertex attribute
        float isWater = vMaterialType; // 1 for water, 0 for glass
        
        // --- Animation (only for water blocks) ---
        // Create a scrolling effect by offsetting UVs with time.
        // Only apply animation to water, glass stays completely static
        vec2 animationOffset = vec2(-time * 0.3, time * 0.4) * isWater;
        vec2 tiledLocalUV = (vUV * vUV3) + animationOffset;
        vec2 singleTileUV = fract(tiledLocalUV);

        // --- Texture Sampling with LOD ---
        vec2 dx = dFdx(singleTileUV) * atlasTileSize;
        vec2 dy = dFdy(singleTileUV) * atlasTileSize;
        float lod = log2(max(length(dx), length(dy)));
        vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

        vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
        vec3 normalMap = texture2DLodEXT(normalTexture, atlasUV, lod).rgb;
        normalMap = normalize(normalMap * 2.0 - 1.0);

        vec3 worldNormal = normalize(vTBN * normalMap);

        // --- Lighting Calculation ---
        vec3 normalizedLightDirection = normalize(lightDirection);

        float diffuseIntensity = max(0.0, dot(worldNormal, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(normalizedLightDirection + viewDirection);
        
        // --- Specular highlights: blend between glass (128) and water (32) based on material type ---
        float shininess = mix(128.0, 32.0, isWater); // Glass: 128, Water: 32
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), shininess);
        float specularIntensity = mix(0.5, 0.4, isWater); // Glass: 0.5, Water: 0.4
        vec3 specular = vec3(specularIntensity) * spec;

        // --- Ambient Occlusion ---
        float aoFactor = 1.0 - vAO * mix(0.1, 0.24, isWater); // Glass: 0.1, Water: 0.24
        float lightLevel = max(vSkyLight, vBlockLight);
        
        // --- Light Coloring ---
        vec3 skyColor = vec3(0.6, 0.8, 1.0); // Blue-ish for sky
        vec3 blockColor = vec3(1.0, 0.6, 0.2); // Orange-ish for block light
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);

        // --- Final Color ---
        // Blend between water-like (darker base) and glass-like (brighter) rendering
        float baseColorMultiplier = mix(1.0, 0.5, isWater); // Glass: 1.0, Water: 0.5
        vec3 litColor = diffuseColor.rgb * baseColorMultiplier + diffuse + specular;

        // Desaturate more in low light for water, less for glass
        float luminance = dot(litColor, vec3(0.299, 0.587, 0.114));
        float saturation = mix(1.0, 0.5, isWater); // Glass keeps full saturation, water desaturates
        litColor = mix(vec3(luminance), litColor, lightLevel * saturation + (1.0 - saturation));

        vec3 finalColor = litColor * max(lightMix * aoFactor, mix(0.06, 0.1, isWater));

        // --- Alpha Blending ---
        // Glass: full alpha, Water: variable alpha based on light level
        float baseAlpha = diffuseColor.a;
        float alpha = baseAlpha * mix(1.0, mix(0.9, 0.4, lightLevel), isWater);

        gl_FragColor = vec4(finalColor, alpha);
    }
  `;
}
