export class DiffuseOnlyShader {
  static readonly chunkVertexShader = `
precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec2 uv2; // uv2 = atlas tile offset (u,v)
attribute vec2 uv3; // uv3 = tiling count (w,h)

// Uniforms
uniform mat4 world;
uniform mat4 worldViewProjection;

// Varyings
varying vec2 vUV;
varying vec2 vUV2;
varying vec2 vUV3;
varying vec3 vNormalW;

void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);
    vUV = uv;
    vUV2 = uv2;
    vUV3 = uv3;
    vNormalW = normalize(mat3(world) * normal);
}
`;
  static readonly chunkFragmentShader = `
    precision highp float;

    varying vec2 vUV;  // Interpolated LOCAL quad UVs (0 to 1)
    varying vec2 vUV2; // u = tile's top-left U, v = tile's top-left V
    varying vec2 vUV3; // u = quad width, v = quad height

    varying vec3 vNormalW;

    uniform sampler2D diffuseTexture;
    uniform float atlasTileSize;
    uniform vec3 lightDirection;

    void main(void) {
        // 1. Scale the local UV by the quad's dimensions to get a repeating value.
        vec2 tiledLocalUV = vUV * vUV3;

        vec2 singleTileUV = fract(tiledLocalUV);

        // 3. Scale this 0->1 pattern to the size of one tile in the atlas.
        vec2 scaledTileUV = singleTileUV * atlasTileSize;

        // 4. Offset this by the tile's base position in the atlas.
        vec2 finalUV = vUV2 + scaledTileUV;

        // 5. Sample the diffuse and normal textures.
        vec4 diffuseColor = texture2D(diffuseTexture, finalUV);

        // --- Lighting Calculation ---
        vec3 normalizedLightDirection = -normalize(lightDirection);

        float diffuseIntensity = max(0.0, dot(vNormalW, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        // Combine ambient and diffuse for final color
        gl_FragColor = vec4(diffuseColor.rgb * 0.4 + diffuse, diffuseColor.a);
    }
`;
}
