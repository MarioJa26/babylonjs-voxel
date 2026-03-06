export class OpaqueShader {
  static readonly chunkVertexShader = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec4 faceDataA; // x,y,z origin, w = axisFace(0..5)
attribute vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
attribute vec4 faceDataC; // x=packedAO, y=light, z=materialType, w=flip

// Uniforms
uniform mat4 world;
uniform mat4 worldViewProjection;
uniform float atlasTileSize;
uniform float maxAtlasTiles;
uniform float sunLightIntensity;

// Varyings
varying vec2 vUV;
varying vec2 vUV2;
varying vec3 vPositionW;
varying mat3 vTBN;
varying float vAO;
varying float vSkyLight;
varying float vBlockLight;
varying float vMaterialType;
varying vec3 vSkyColor;
varying vec3 vBlockColor;

float decodeCorner(float vertexId, float isBackFace, float flip) {
    if (isBackFace > 0.5) {
        if (flip > 0.5) {
            if (vertexId < 0.5) return 0.0;
            if (vertexId < 1.5) return 1.0;
            if (vertexId < 2.5) return 3.0;
            if (vertexId < 3.5) return 1.0;
            if (vertexId < 4.5) return 2.0;
            return 3.0;
        }
        if (vertexId < 0.5) return 0.0;
        if (vertexId < 1.5) return 1.0;
        if (vertexId < 2.5) return 2.0;
        if (vertexId < 3.5) return 0.0;
        if (vertexId < 4.5) return 2.0;
        return 3.0;
    }

    if (flip > 0.5) {
        if (vertexId < 0.5) return 0.0;
        if (vertexId < 1.5) return 3.0;
        if (vertexId < 2.5) return 1.0;
        if (vertexId < 3.5) return 1.0;
        if (vertexId < 4.5) return 3.0;
        return 2.0;
    }
    if (vertexId < 0.5) return 0.0;
    if (vertexId < 1.5) return 2.0;
    if (vertexId < 2.5) return 1.0;
    if (vertexId < 3.5) return 0.0;
    if (vertexId < 4.5) return 3.0;
    return 2.0;
}

void decodeAtlasCorner(float axisFace, float corner, out float cornerId, out float swapUV) {
    if (axisFace < 0.5) {
        swapUV = 1.0;
        cornerId = corner < 0.5 ? 0.0 : (corner < 1.5 ? 3.0 : (corner < 2.5 ? 2.0 : 1.0));
        return;
    }
    if (axisFace < 1.5) {
        swapUV = 1.0;
        cornerId = corner < 0.5 ? 1.0 : (corner < 1.5 ? 2.0 : (corner < 2.5 ? 3.0 : 0.0));
        return;
    }
    if (axisFace < 2.5) {
        swapUV = 1.0;
        cornerId = corner < 0.5 ? 0.0 : (corner < 1.5 ? 3.0 : (corner < 2.5 ? 2.0 : 1.0));
        return;
    }
    if (axisFace < 3.5) {
        swapUV = 1.0;
        cornerId = corner < 0.5 ? 3.0 : (corner < 1.5 ? 0.0 : (corner < 2.5 ? 1.0 : 2.0));
        return;
    }
    if (axisFace < 4.5) {
        swapUV = 0.0;
        cornerId = corner < 0.5 ? 1.0 : (corner < 1.5 ? 0.0 : (corner < 2.5 ? 3.0 : 2.0));
        return;
    }
    swapUV = 0.0;
    cornerId = corner < 0.5 ? 0.0 : (corner < 1.5 ? 1.0 : (corner < 2.5 ? 2.0 : 3.0));
}

void main(void) {
    float axisFace = floor(faceDataA.w + 0.5);
    float axis = floor(axisFace * 0.5);
    float isBackFace = mod(axisFace, 2.0);
    float vertexId = floor(position.x + 0.5);
    float flip = step(0.5, faceDataC.w);

    float corner = decodeCorner(vertexId, isBackFace, flip);
    float du = (corner > 0.5 && corner < 2.5) ? faceDataB.x : 0.0;
    float dv = corner > 1.5 ? faceDataB.y : 0.0;

    float uAxis = mod(axis + 1.0, 3.0);
    float vAxis = mod(axis + 2.0, 3.0);

    vec3 localPosition = faceDataA.xyz;
    if (uAxis < 0.5) localPosition.x += du;
    else if (uAxis < 1.5) localPosition.y += du;
    else localPosition.z += du;

    if (vAxis < 0.5) localPosition.x += dv;
    else if (vAxis < 1.5) localPosition.y += dv;
    else localPosition.z += dv;

    gl_Position = worldViewProjection * vec4(localPosition, 1.0);

    float atlasCornerId;
    float swapUV;
    decodeAtlasCorner(axisFace, corner, atlasCornerId, swapUV);
    float u = step(1.0, atlasCornerId) - step(3.0, atlasCornerId);
    float v = step(2.0, atlasCornerId);

    float uDim = mix(faceDataB.x, faceDataB.y, swapUV);
    float vDim = mix(faceDataB.y, faceDataB.x, swapUV);
    vUV = vec2(u, v) * vec2(uDim, vDim);

    float maxTiles = floor(1.0 / atlasTileSize + 0.5);
    vUV2 = vec2(faceDataB.z, maxAtlasTiles - 1.0 - faceDataB.w) * atlasTileSize;
    
    vPositionW = (world * vec4(localPosition, 1.0)).xyz;
    
    vec3 normal = vec3(0.0);
    if (axis < 0.5) normal.x = isBackFace > 0.5 ? -1.0 : 1.0;
    else if (axis < 1.5) normal.y = isBackFace > 0.5 ? -1.0 : 1.0;
    else normal.z = isBackFace > 0.5 ? -1.0 : 1.0;

    vec3 N = normalize(mat3(world) * normal);
    vec3 absN = abs(normal);
    float isX = step(0.5, absN.x);
    float isY = step(0.5, absN.y);
    vec3 tObj = vec3(1.0 - isX - isY, isX, isY);

    float handedness = sign(normal.x + normal.y + normal.z);
    vec3 T = normalize(mat3(world) * tObj);
    vec3 B = normalize(cross(N, T) * handedness);
    vTBN = mat3(T, B, N);

    float packedAO = faceDataC.x;
    if (corner < 0.5) {
        vAO = mod(packedAO, 4.0);
    } else if (corner < 1.5) {
        vAO = mod(floor(packedAO * 0.25), 4.0);
    } else if (corner < 2.5) {
        vAO = mod(floor(packedAO * 0.0625), 4.0);
    } else {
        vAO = mod(floor(packedAO * 0.015625), 4.0);
    }

    float light = faceDataC.y;
    vSkyLight = floor(light * 0.0625) * 0.0666666;
    vBlockLight = mod(light, 16.0) * 0.0666666;
    vMaterialType = faceDataC.z;

    vSkyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
    vBlockColor = vec3(0.9, 0.6, 0.2);
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
    varying vec3 vSkyColor;
    varying vec3 vBlockColor;

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
        
        // Colors are now provided by varyings vSkyColor and vBlockColor
        vec3 lightMix = clamp((vSkyLight * vSkyColor) + (vBlockLight * vBlockColor), 0.2, 1.0);
        
        vec3 finalColor = (diffuseColor.rgb + diffuse + specular) * lightMix * aoFactor;

        gl_FragColor = vec4(finalColor, diffuseColor.a);    
    }
`;
}
