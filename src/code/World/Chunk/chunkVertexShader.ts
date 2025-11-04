export const chunkVertexShader = `
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
