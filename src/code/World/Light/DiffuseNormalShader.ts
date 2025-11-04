export class DiffuseNormalShader {
  static readonly chunkVertexShader = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec2 uv2; // uv2 = atlas tile offset (u,v)
attribute vec2 uv3; // uv3 = tiling count (w,h)
attribute vec4 tangent;

// Uniforms
uniform mat4 world;
uniform mat4 worldViewProjection;

// Varyings
varying vec2 vUV;
varying vec2 vUV2;
varying vec2 vUV3;
varying vec3 vPositionW;
varying mat3 vTBN;

void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);
    vUV = uv;
    vUV2 = uv2;
    vUV3 = uv3;
    vPositionW = (world * vec4(position, 1.0)).xyz;
vec3 N = normalize(mat3(world) * normal);
vec3 T = normalize(mat3(world) * tangent.xyz);
vec3 B = normalize(cross(N, T) * tangent.w);
vTBN = mat3(T, B, N);
}
`;
  static readonly chunkFragmentShader = `
    precision highp float;

    varying vec2 vUV;  // Interpolated LOCAL quad UVs (0 to 1)
    varying vec2 vUV2; // u = tile's top-left U, v = tile's top-left V
    varying vec2 vUV3; // u = quad width, v = quad height

    varying vec3 vPositionW;
    varying mat3 vTBN;

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
    uniform float atlasTileSize;
    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;

    void main(void) {
        // 1. Scale the local UV by the quad's dimensions to get a repeating value.
        // eg: vUV.x goes 0->1, vUV3.x is 5, so tiledLocalUV.x goes 0->5
        vec2 tiledLocalUV = vUV * vUV3;

        // 2. Get the fractional part to create the 0->1 repeating pattern.
        vec2 singleTileUV = fract(tiledLocalUV);

        // 3. Scale this 0->1 pattern to the size of one tile in the atlas.
        vec2 scaledTileUV = singleTileUV * atlasTileSize;

        // 4. Offset this by the tile's base position in the atlas.
        vec2 finalUV = vUV2 + scaledTileUV;

        // 5. Sample the diffuse and normal textures.
        vec4 diffuseColor = texture2D(diffuseTexture, finalUV);
        vec3 normalMap = texture2D(normalTexture, finalUV).rgb;

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
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 32.0);
        vec3 specular = vec3(0.3) * spec; // Specular color is white

        gl_FragColor = vec4(diffuseColor.rgb * 0.4 + diffuse + specular, diffuseColor.a);
    }
`;
}
