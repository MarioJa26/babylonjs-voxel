export class DiffuseNormalShader {
  static readonly chunkVertexShader = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv2; 
attribute float cornerId; 
attribute vec2 uv3; 
attribute float ao;
attribute float light;

uniform mat4 world;
uniform mat4 worldViewProjection;
uniform float atlasTileSize;
uniform float sunLightIntensity; // Moved here for color math

varying vec2 vUV;
varying vec2 vUV2;
varying vec2 vUV3;
varying vec3 vPositionW;
varying mat3 vTBN;
varying vec3 vLightFactor; // The pre-calculated color multiplier

void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);

    // --- Original UV/Position Logic ---
    float u = step(1.0, cornerId) - step(3.0, cornerId); 
    float v = step(2.0, cornerId); 
    vUV = vec2(u, v);

    float u_base = uv2.x * atlasTileSize;
    float v_base_flipped = 1.0 - (uv2.y * atlasTileSize + atlasTileSize);
    vUV2 = vec2(u_base, v_base_flipped);

    vUV3 = uv3; 
    vPositionW = (world * vec4(position, 1.0)).xyz;
    vec3 N = normalize(mat3(world) * normal);

    // --- Original TBN Logic ---
    vec3 absN = abs(normal);
    float isX = step(0.5, absN.x);
    float isY = step(0.5, absN.y);
    vec3 tObj = vec3(1.0 - isX - isY, isX, isY);

    float handedness = sign(normal.x + normal.y + normal.z);
    vec3 T = normalize(mat3(world) * tObj);
    vec3 B = normalize(cross(N, T) * handedness);
    vTBN = mat3(T, B, N);

    // --- Moved Color Math (The Optimization) ---
    float skyL = floor(light / 16.0) / 15.0;
    float blockL = mod(light, 16.0) / 15.0;
    float aoFactor = 1.0 - ao * 0.23;

    vec3 skyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
    vec3 blockColor = vec3(0.9, 0.6, 0.2);
    
    // Combine light types and AO into one varying
    vec3 lightMix = clamp((skyL * skyColor) + (blockL * blockColor), 0.0, 1.0);
    vLightFactor = lightMix * aoFactor;
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
varying vec3 vLightFactor; // Received from vertex shader

uniform sampler2D diffuseTexture;
uniform sampler2D normalTexture;
uniform float atlasTileSize;
uniform vec3 cameraPosition;
uniform vec3 lightDirection;
uniform float sunLightIntensity;
uniform float wetness;

void main(void) {
    // 1. Original Tiling Logic
    vec2 tiledLocalUV = vUV * vUV3;
    vec2 singleTileUV = fract(tiledLocalUV);

    // 2. Original Manual LOD Logic (Kept for performance/correctness)
    vec2 dx = dFdx(singleTileUV) * atlasTileSize;
    vec2 dy = dFdy(singleTileUV) * atlasTileSize;
    float lod = log2(max(length(dx), length(dy)));
    vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

    vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
    diffuseColor.rgb *= mix(1.0, 0.5, wetness);

    // 3. Original Normal Mapping
    vec3 normalMap = texture2DLodEXT(normalTexture, atlasUV, lod).rgb;
    normalMap = normalize(normalMap * 2.0 - 1.0);
    vec3 worldNormal = normalize(vTBN * normalMap);

    // 4. Lighting Calculation
    float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));
    vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

    vec3 viewVec = cameraPosition - vPositionW;
    vec3 viewDirection = normalize(viewVec);
    vec3 halfwayDir = normalize(viewDirection + lightDirection);
    
    float shininess = mix(16.0, 128.0, wetness);
    float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), shininess);
    float specIntensity = mix(0.05, 2.0, wetness);
    vec3 specular = vec3(specIntensity) * spec * max(sunLightIntensity - 0.1, 0.0);

    // 5. Final Composite (Using pre-calculated vLightFactor)
    vec3 finalColor = (diffuseColor.rgb + diffuse + specular) * max(vLightFactor, 0.2);

    gl_FragColor = vec4(finalColor, diffuseColor.a);    
}
`;
}
