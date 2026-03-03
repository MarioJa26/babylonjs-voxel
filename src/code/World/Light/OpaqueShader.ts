export class OpaqueShader {
  static readonly chunkVertexShader = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec4 uvData;      // x: tileX, y: tileY, z: quadWidth, w: quadHeight
attribute float cornerId;   // 0,1,2,3 for quad corners
attribute float ao;
attribute float light;
attribute float materialType;

// Uniforms
uniform mat4 world;
uniform mat4 worldViewProjection;
uniform float atlasTileSize;

// Varyings
varying vec2 vUV;
varying vec2 vUV2;
varying vec3 vPositionW;
varying mat3 vTBN;
varying float vAO;
varying float vSkyLight;
varying float vBlockLight;
varying float vMaterialType;

void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);

    // 1. UV decoding
    float u = step(1.0, cornerId) - step(3.0, cornerId); 
    float v = step(2.0, cornerId);                       

    // 2. Scale local UVs
    vUV = vec2(u, v) * uvData.zw;

    // 3. Atlas offset
    float maxTiles = floor(1.0 / atlasTileSize + 0.5);
    vUV2 = vec2(uvData.x, maxTiles - 1.0 - uvData.y) * atlasTileSize;
    
    vPositionW = (world * vec4(position, 1.0)).xyz;
    
    // 4. TBN Reconstruction
    vec3 N = normalize(mat3(world) * normal);
    vec3 absN = abs(normal);
    float isX = step(0.5, absN.x);
    float isY = step(0.5, absN.y);
    vec3 tObj = vec3(1.0 - isX - isY, isX, isY);

    float handedness = sign(normal.x + normal.y + normal.z);
    vec3 T = normalize(mat3(world) * tObj);
    vec3 B = normalize(cross(N, T) * handedness);
    vTBN = mat3(T, B, N);

    // 5. Light Unpacking
    vAO = ao;
    vSkyLight = floor(light * 0.0625) * 0.0666666;
    vBlockLight = mod(light, 16.0) * 0.0666666;
    vMaterialType = materialType;
}
`;

  static readonly chunkFragmentShader = `
    precision highp float;

    #extension GL_EXT_shader_texture_lod : enable
    #extension GL_OES_standard_derivatives : enable

    varying vec2 vUV;  
    varying vec2 vUV2; 
    varying vec3 vPositionW;
    varying mat3 vTBN;
    varying float vAO;
    varying float vSkyLight;
    varying float vBlockLight;

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
    uniform float atlasTileSize;
    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float sunLightIntensity;
    uniform float wetness;

    void main(void) {
        // 1. UV setup
        vec2 singleTileUV = fract(vUV);
        vec2 dx = dFdx(vUV) * atlasTileSize;
        vec2 dy = dFdy(vUV) * atlasTileSize;
        float lod = log2(max(length(dx), length(dy)));
        vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

        // 2. Sampling
        vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
        diffuseColor.rgb *= mix(1.0, 0.5, wetness);

        vec3 normalMap = texture2DLodEXT(normalTexture, atlasUV, lod).rgb;
        normalMap = normalize(normalMap * 2.0 - 1.0); 
        vec3 worldNormal = normalize(vTBN * normalMap);

        // 3. Diffuse Lighting
        float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        // 4. SPECULAR MUTING
        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(viewDirection + lightDirection);
        float shininess = mix(16.0, 128.0, wetness);
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), shininess);
        
        float specIntensity = mix(0.05, 2.0, wetness) * vSkyLight;
        vec3 specular = vec3(specIntensity) * spec * max(sunLightIntensity - 0.1, 0.0);

        // 5. Final Coloring
        float aoFactor = 1.0 - vAO * 0.23; 
        vec3 skyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
        vec3 blockColor = vec3(0.9, 0.6, 0.2);
        
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.2, 1.0);
        
        // Fix: Apply AO factor AFTER the 0.2 floor.
        // This keeps corners darker than flat faces even at minimum light.
        vec3 finalColor = (diffuseColor.rgb + diffuse + specular) * lightMix * aoFactor;

        gl_FragColor = vec4(finalColor, diffuseColor.a);    
    }
`;
}
