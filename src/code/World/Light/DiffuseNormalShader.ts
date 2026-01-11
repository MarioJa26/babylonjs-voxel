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

// Uniforms
uniform mat4 world;
uniform mat4 worldViewProjection;
uniform vec2 screenSize;

// Varyings - data passed to fragment shader
varying vec2 vUV;
varying vec2 vUV2;
varying vec2 vUV3;
varying vec3 vPositionW;
varying mat3 vTBN;
varying vec2 vScreenSize;
varying float vAO;
varying float vSkyLight;
varying float vBlockLight;

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

    // Pass screen size to fragment shader for depth calculations
    vScreenSize = screenSize;

    vAO = ao;
    // Unpack light (0-255) into sky (high 4 bits) and block (low 4 bits)
    vSkyLight = floor(light / 16.0) / 15.0;
    vBlockLight = mod(light, 16.0) / 15.0;
}
`;
  static readonly chunkFragmentShader = `
    precision highp float;

    // Enable standard derivatives extension for dFdx and dFdy
    #extension GL_EXT_shader_texture_lod : enable
    #extension GL_OES_standard_derivatives : enable

    varying vec2 vUV;  // Interpolated LOCAL quad UVs (0 to 1)
    varying vec2 vUV2; // u = tile's top-left U, v = tile's top-left V
    varying vec2 vUV3; // u = quad width, v = quad height

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

    // Samples from a texture atlas, calculating derivatives manually to avoid mipmap bleeding.
    vec4 texture2D_with_derivatives(sampler2D atlas, vec2 tileOffset, vec2 tileUV, float tileSize) {
        // Calculate the UV coordinates within the atlas for the main sample
        vec2 atlasUV = tileOffset + tileUV * tileSize;

        // Calculate derivatives of the atlas UVs
        // dFdx/dFdy calculate the rate of change of a variable for the adjacent fragment horizontally/vertically.
        // By multiplying the tile's UV derivative by the tile size, we get the correct derivative
        // as if we were sampling a standalone, repeating texture.
        vec2 dx = dFdx(tileUV) * tileSize;
        vec2 dy = dFdy(tileUV) * tileSize;

        // Calculate the explicit LOD level using the derivatives.
        // log2(max(length(dx), length(dy))) gives the ideal mipmap level.
        float lod = log2(max(length(dx), length(dy)));

        // Sample the texture using the explicit LOD.
        return texture2DLodEXT(atlas, atlasUV, lod);
    }
    void main(void) {
        // 1. Scale the local UV by the quad's dimensions to get a repeating value.
        // eg: vUV.x goes 0->1, vUV3.x is 5, so tiledLocalUV.x goes 0->5
        vec2 tiledLocalUV = vUV * vUV3;

        // 2. Get the fractional part to create the 0->1 repeating pattern.
        vec2 singleTileUV = fract(tiledLocalUV);

        // 3. Sample the diffuse and normal textures using manual derivatives.
        // vUV2 is the tile's base offset in the atlas.
        // singleTileUV is the coordinate within the tile (0-1).
        // atlasTileSize is the size of one tile relative to the atlas (1/16).
        vec4 diffuseColor = texture2D_with_derivatives(diffuseTexture, vUV2, singleTileUV, atlasTileSize);
        vec3 normalMap = texture2D_with_derivatives(normalTexture, vUV2, singleTileUV, atlasTileSize).rgb;

        // 6. Transform the normal from tangent space (read from map) to world space.
        normalMap = normalize(normalMap * 2.0 - 1.0); // Unpack normal from [0,1] to [-1,1]
        vec3 worldNormal = normalize(vTBN * normalMap);

        // --- Lighting Calculation ---
        // Ensure the light direction vector is normalized before use.
        vec3 normalizedLightDirection = -normalize(lightDirection);

        float diffuseIntensity = max(0.0, dot(worldNormal, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(normalizedLightDirection + viewDirection);
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 16.0);
        vec3 specular = vec3(0.3) * spec; // Specular color is white

        float aoFactor = 1.0 - vAO * 0.23; // 0->1, 1->0.85, 2->0.7, 3->0.55
        
        // --- Light Coloring for Testing ---
        vec3 skyColor = vec3(0.8, 0.8, 0.8); // Blue-ish for sky
        vec3 blockColor = vec3(1.0, 0.6, 0.2); // Orange-ish for block light
        
        vec3 lightMix = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);
        
        vec3 finalColor = (diffuseColor.rgb * 0.8 + diffuse + specular) * max(lightMix * aoFactor, 0.1);

        gl_FragColor = vec4(finalColor, diffuseColor.a);  
    }
`;
}
