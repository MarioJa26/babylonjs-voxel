export class GlassShader {
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

    // Uniforms
    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float atlasTileSize;

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;

    uniform vec2 cameraPlanes; // Represents camera.minZ and camera.maxZ

    void main(void) {
        // For glass, we use static tiling without animation.
        vec2 tiledLocalUV = vUV * vUV3;
        vec2 singleTileUV = fract(tiledLocalUV);

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
        // Increased specular power for a harder, glass-like shine
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 128.0);
        vec3 specular = vec3(0.5) * spec;

        // --- Ambient Occlusion ---
        float aoFactor = 1.0 - vAO * 0.1;
        float lightLevel = max(vSkyLight, vBlockLight);
        
        // --- Light Coloring for Testing ---
        vec3 skyColor = vec3(0.6, 0.8, 1.0); // Blue-ish for sky
        vec3 blockColor = vec3(1.0, 0.6, 0.2); // Orange-ish for block light
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);

        vec3 litColor = diffuseColor.rgb  + diffuse + specular;
        vec3 finalColor = litColor * max(lightMix * aoFactor, 0.06);

        // Use a fixed alpha or one from the texture for blending
        gl_FragColor = vec4(finalColor, diffuseColor.a); // Use the texture's alpha directly
    }
  `;
}
