export class DiffuseNormalShader {
  static readonly chunkVertexShader = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv2; // uv2 = tile coords (tx, ty)
attribute float cornerId; // 0,1,2,3 for quad corners
attribute vec2 uv3; // uv3 = quad dimensions (w,h)
attribute float ao;
attribute float light;
attribute float materialId; // 0=opaque, 1=water, 2=glass

// Uniforms
uniform mat4 world;
uniform mat4 worldViewProjection;

// Varyings - data passed to fragment shader
varying vec2 vUV;
varying vec2 vUV2;
varying vec2 vUV3;
varying vec3 vPositionW;
varying mat3 vTBN;
varying float vAO;
varying float vSkyLight;
varying float vBlockLight;
varying float vMaterialId;

uniform float atlasTileSize;

void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);

    // UV decoding from cornerId (0,1,2,3)
    float u = step(1.0, cornerId) - step(3.0, cornerId); // (0,1,1,0)
    float v = step(2.0, cornerId);                       // (0,0,1,1)

    vUV = vec2(u, v);

    // Calculate atlas tile offset (vUV2) from integer tile coordinates (uv2)
    float u_base = uv2.x * atlasTileSize;
    float v_base_flipped = 1.0 - (uv2.y * atlasTileSize + atlasTileSize);
    vUV2 = vec2(u_base, v_base_flipped);

    vUV3 = uv3; // Pass quad dimensions
    vPositionW = (world * vec4(position, 1.0)).xyz;
    vec3 N = normalize(mat3(world) * normal);

    // Reconstruct Tangent and Binormal from the Normal (assuming axis-aligned blocks)
    vec3 absN = abs(normal);
    float isX = step(0.5, absN.x);
    float isY = step(0.5, absN.y);
    vec3 tObj = vec3(1.0 - isX - isY, isX, isY);

    float handedness = sign(normal.x + normal.y + normal.z);
    vec3 T = normalize(mat3(world) * tObj);
    vec3 B = normalize(cross(N, T) * handedness);
    vTBN = mat3(T, B, N);

    vAO = ao;
    // Unpack light (0-255) into sky (high 4 bits) and block (low 4 bits)
    vSkyLight = floor(light / 16.0) / 15.0;
    vBlockLight = mod(light, 16.0) / 15.0;
    vMaterialId = materialId;
}
`;
  static readonly chunkFragmentShader = `
    precision highp float;

    #extension GL_EXT_shader_texture_lod : enable
    #extension GL_OES_standard_derivatives : enable

    varying vec2 vUV;
    varying vec2 vUV2;
    varying vec2 vUV3;
    varying vec3 vPositionW;
    varying mat3 vTBN;
    varying float vAO;
    varying float vSkyLight;
    varying float vBlockLight;
    varying float vMaterialId;

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
    uniform float atlasTileSize;
    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float time;

    // --- Opaque shading ---
    vec4 shadeOpaque(vec2 singleTileUV, float lod) {
        vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;
        vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
        vec3 normalMap = texture2DLodEXT(normalTexture, atlasUV, lod).rgb;

        normalMap = normalize(normalMap * 2.0 - 1.0);
        vec3 worldNormal = normalize(vTBN * normalMap);

        vec3 normalizedLightDirection = -normalize(lightDirection);
        float diffuseIntensity = max(0.0, dot(worldNormal, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(normalizedLightDirection + viewDirection);
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 16.0);
        vec3 specular = vec3(0.3) * spec;

        float aoFactor = 1.0 - vAO * 0.23;
        vec3 skyColor = vec3(0.8, 0.8, 0.8);
        vec3 blockColor = vec3(1.0, 0.6, 0.2);
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);

        vec3 finalColor = (diffuseColor.rgb * 0.8 + diffuse + specular) * max(lightMix * aoFactor, 0.1);
        return vec4(finalColor, diffuseColor.a);
    }

    // --- Water shading ---
    vec4 shadeWater(vec2 singleTileUV, float lod) {
        // Animated water UVs
        vec2 animatedUV = singleTileUV - vec2(-time * 0.3, time * 0.4);
        vec2 atlasUV = vUV2 + fract(animatedUV) * atlasTileSize;

        vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
        vec3 normalMap = texture2DLodEXT(normalTexture, atlasUV, lod).rgb;

        normalMap = normalize(normalMap * 2.0 - 1.0);
        vec3 worldNormal = normalize(vTBN * normalMap);

        vec3 normalizedLightDirection = -normalize(lightDirection);
        float diffuseIntensity = max(0.0, dot(worldNormal, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(normalizedLightDirection + viewDirection);
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 32.0);
        vec3 specular = vec3(0.4) * spec;

        float aoFactor = 1.0 - vAO * 0.24;
        vec3 skyColor = vec3(0.6, 0.8, 1.0);
        vec3 blockColor = vec3(1.0, 0.6, 0.2);
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);

        vec3 litColor = diffuseColor.rgb * 0.5 + diffuse + specular;
        vec3 finalColor = litColor * max(lightMix * aoFactor, 0.1);

        float lightLevel = max(vSkyLight, vBlockLight);
        return vec4(finalColor, diffuseColor.a * mix(0.9, 0.4, lightLevel));
    }

    // --- Glass shading ---
    vec4 shadeGlass(vec2 singleTileUV, float lod) {
        vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;
        vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
        vec3 normalMap = texture2DLodEXT(normalTexture, atlasUV, lod).rgb;

        normalMap = normalize(normalMap * 2.0 - 1.0);
        vec3 worldNormal = normalize(vTBN * normalMap);

        vec3 normalizedLightDirection = -normalize(lightDirection);
        float diffuseIntensity = max(0.0, dot(worldNormal, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(normalizedLightDirection + viewDirection);
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 128.0);
        vec3 specular = vec3(0.5) * spec;

        float aoFactor = 1.0 - vAO * 0.1;
        vec3 skyColor = vec3(0.6, 0.8, 1.0);
        vec3 blockColor = vec3(1.0, 0.6, 0.2);
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);

        vec3 litColor = diffuseColor.rgb + diffuse + specular;
        vec3 finalColor = litColor * max(lightMix * aoFactor, 0.06);

        return vec4(finalColor, diffuseColor.a);
    }

    void main(void) {
        vec2 tiledLocalUV = vUV * vUV3;
        vec2 singleTileUV = fract(tiledLocalUV);

        vec2 dx = dFdx(singleTileUV) * atlasTileSize;
        vec2 dy = dFdy(singleTileUV) * atlasTileSize;
        float lod = log2(max(length(dx), length(dy)));

        // Route to appropriate shader based on materialId
        if (vMaterialId < 0.5) {
            // Opaque
            gl_FragColor = shadeOpaque(singleTileUV, lod);
        } else if (vMaterialId < 1.5) {
            // Water
            gl_FragColor = shadeWater(singleTileUV, lod);
        } else {
            // Glass
            gl_FragColor = shadeGlass(singleTileUV, lod);
        }
    }
  `;
}
