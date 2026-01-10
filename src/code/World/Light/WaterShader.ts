export class WaterShader {
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
    varying vec2 vScreenSize;
    varying float vAO;
    varying float vSkyLight;
    varying float vBlockLight;

    // Uniforms
    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float atlasTileSize;
    uniform float time; // Time in seconds for animation

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
    uniform sampler2D depthSampler;

    vec4 texture2D_with_derivatives(sampler2D atlas, vec2 tileOffset, vec2 tileUV, float tileSize) {
        vec2 atlasUV = tileOffset + tileUV * tileSize;
        vec2 dx = dFdx(tileUV) * tileSize;
        vec2 dy = dFdy(tileUV) * tileSize;
        float lod = log2(max(length(dx), length(dy)));
        return texture2DLodEXT(atlas, atlasUV, lod);
    }

    // Function to linearize depth value from depth map
    float linearizeDepth(float depth, float zNear, float zFar) {
        float z = depth * 2.0 - 1.0; // Back to NDC
        return (2.0 * zNear * zFar) / (zFar + zNear - z * (zFar - zNear));
    }

    uniform vec2 cameraPlanes; // Represents camera.minZ and camera.maxZ

    void main(void) {
        // --- Animation ---
        // Create a scrolling effect by offsetting UVs with time.
        // Simplified animation as we only render the top face now.
        vec2 tiledLocalUV = (vUV * vUV3) - vec2(-time * 0.3, time * 0.4);
        vec2 singleTileUV = fract(tiledLocalUV);

        vec4 diffuseColor = texture2D_with_derivatives(diffuseTexture, vUV2, singleTileUV, atlasTileSize); 

        vec3 normalMap = texture2D_with_derivatives(normalTexture, vUV2, singleTileUV, atlasTileSize).rgb;
        normalMap = normalize(normalMap * 2.0 - 1.0);

        vec3 worldNormal = normalize(vTBN * normalMap);

        // --- Lighting Calculation ---
        vec3 normalizedLightDirection = -normalize(lightDirection);

        float diffuseIntensity = max(0.0, dot(worldNormal, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(normalizedLightDirection + viewDirection);
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 32.0);
        vec3 specular = vec3(0.4) * spec;

        // --- Ambient Occlusion ---
        float aoFactor = 1.0 - vAO * 0.24;
        vec3 litColor = diffuseColor.rgb * 0.5 + diffuse + specular;

        float lightLevel = max(vSkyLight, vBlockLight);

        // Desaturate color in low light
        float luminance = dot(litColor, vec3(0.299, 0.587, 0.114));
        litColor = mix(vec3(luminance), litColor, lightLevel);

        // --- Light Coloring for Testing ---
        vec3 skyColor = vec3(0.6, 0.8, 1.0); // Blue-ish for sky
        vec3 blockColor = vec3(1.0, 0.6, 0.2); // Orange-ish for block light
        
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);

        vec3 finalColor = litColor * max(lightMix * aoFactor, 0.1);

        // Apply alpha for transparency
        gl_FragColor = vec4(finalColor, diffuseColor.a * mix(0.9, 0.4, lightLevel));
    }
  `;
}
