/**
 * ChunkShader — single shader for all block types.
 *
 * The vertex shader passes `blockCategory` through as a flat varying.
 * The fragment shader branches on it:
 *   0 = opaque  (original DiffuseNormalShader behaviour)
 *   1 = water   (scrolling UV animation, variable alpha)
 *   2 = glass   (harder specular, texture alpha)
 *
 * All three types share the same lighting math — only UV animation
 * and the final alpha differ.
 */
export class ChunkShader {
  static readonly vertexShader = /* glsl */`
precision highp float;

attribute vec3  position;
attribute vec3  normal;
attribute vec2  uv2;       // tile coords (tx, ty)
attribute vec2  uv3;       // quad dimensions (w, h)
attribute float cornerId;  // 0,1,2,3 for quad corners
attribute float ao;
attribute float light;
attribute float blockCategory; // 0=opaque  1=water  2=glass

uniform mat4  world;
uniform mat4  worldViewProjection;
uniform float atlasTileSize;

varying vec2  vUV;
varying vec2  vUV2;
varying vec2  vUV3;
varying vec3  vPositionW;
varying mat3  vTBN;
varying float vAO;
varying float vSkyLight;
varying float vBlockLight;
varying float vBlockCategory; // passed flat to fragment

void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);

    // UV from cornerId  (0→(0,0)  1→(1,0)  2→(1,1)  3→(0,1))
    float u = step(1.0, cornerId) - step(3.0, cornerId);
    float v = step(2.0, cornerId);
    vUV = vec2(u, v);

    float u_base         = uv2.x * atlasTileSize;
    float v_base_flipped = 1.0 - (uv2.y * atlasTileSize + atlasTileSize);
    vUV2 = vec2(u_base, v_base_flipped);
    vUV3 = uv3;

    vPositionW = (world * vec4(position, 1.0)).xyz;

    vec3 N    = normalize(mat3(world) * normal);
    vec3 absN = abs(normal);
    float isX = step(0.5, absN.x);
    float isY = step(0.5, absN.y);
    vec3 tObj = vec3(1.0 - isX - isY, isX, isY);
    float handedness = sign(normal.x + normal.y + normal.z);
    vec3 T  = normalize(mat3(world) * tObj);
    vec3 B  = normalize(cross(N, T) * handedness);
    vTBN    = mat3(T, B, N);

    vAO         = ao;
    vSkyLight   = floor(light / 16.0) / 15.0;
    vBlockLight = mod(light, 16.0) / 15.0;

    vBlockCategory = blockCategory;
}
`;

  static readonly fragmentShader = /* glsl */`
precision highp float;
#extension GL_OES_standard_derivatives : enable
#extension GL_EXT_shader_texture_lod   : enable

varying vec2  vUV;
varying vec2  vUV2;
varying vec2  vUV3;
varying vec3  vPositionW;
varying mat3  vTBN;
varying float vAO;
varying float vSkyLight;
varying float vBlockLight;
varying float vBlockCategory;

uniform sampler2D diffuseTexture;
uniform sampler2D normalTexture;
uniform float atlasTileSize;
uniform vec3  cameraPosition;
uniform vec3  lightDirection;
uniform float sunLightIntensity;
uniform float wetness;
uniform float time;
uniform vec2  cameraPlanes;
uniform vec2  screenSize;

void main(void) {
    // -----------------------------------------------------------------------
    // 1. UV — water animates, opaque/glass are static
    // -----------------------------------------------------------------------
    vec2 tiledLocalUV;
    if (vBlockCategory < 0.5) {
        // opaque
        tiledLocalUV = vUV * vUV3;
    } else if (vBlockCategory < 1.5) {
        // water — scrolling
        tiledLocalUV = (vUV * vUV3) - vec2(-time * 0.3, time * 0.4);
    } else {
        // glass — static
        tiledLocalUV = vUV * vUV3;
    }

    vec2 singleTileUV = fract(tiledLocalUV);

    // -----------------------------------------------------------------------
    // 2. Texture sample (shared LOD path)
    // -----------------------------------------------------------------------
    vec2 dx      = dFdx(singleTileUV) * atlasTileSize;
    vec2 dy      = dFdy(singleTileUV) * atlasTileSize;
    float lod    = log2(max(length(dx), length(dy)));
    vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

    vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
    vec3 normalSample = texture2DLodEXT(normalTexture,  atlasUV, lod).rgb;

    // -----------------------------------------------------------------------
    // 3. Lighting (shared for all categories)
    // -----------------------------------------------------------------------
    vec3 worldNormal = normalize(vTBN * normalize(normalSample * 2.0 - 1.0));

    float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));
    vec3  diffuse          = diffuseColor.rgb * diffuseIntensity;

    vec3  viewVec       = cameraPosition - vPositionW;
    vec3  viewDirection = normalize(viewVec);
    vec3  halfwayDir    = normalize(viewDirection + lightDirection);

    // Shininess: glass > water > opaque; wetness also increases opaque shine
    float shininess;
    if (vBlockCategory < 0.5) {
        shininess = mix(16.0, 128.0, wetness);          // opaque
    } else if (vBlockCategory < 1.5) {
        shininess = 32.0;                               // water
    } else {
        shininess = 128.0;                              // glass
    }

    float specIntensity;
    if (vBlockCategory < 0.5) {
        specIntensity = mix(0.05, 2.0, wetness);        // opaque
    } else if (vBlockCategory < 1.5) {
        specIntensity = 0.4;                            // water
    } else {
        specIntensity = 0.5;                            // glass
    }

    float spec     = pow(max(dot(worldNormal, halfwayDir), 0.0), shininess);
    vec3  specular = vec3(specIntensity) * spec * max(sunLightIntensity - 0.1, 0.0);

    float aoFactor = 1.0 - vAO * 0.23;

    vec3 skyColor   = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
    vec3 blockColor = vec3(0.9, 0.6, 0.2);
    vec3 lightMix   = clamp((vSkyLight * skyColor) + (vBlockLight * blockColor), 0.0, 1.0);

    // -----------------------------------------------------------------------
    // 4. Final colour + alpha per category
    // -----------------------------------------------------------------------
    vec3  finalColor;
    float finalAlpha;

    if (vBlockCategory < 0.5) {
        // ----- Opaque -----
        diffuseColor.rgb *= mix(1.0, 0.5, wetness); // wetness darkens surface
        finalColor = (diffuseColor.rgb + diffuse + specular) * max(lightMix * aoFactor, 0.2);
        finalAlpha = diffuseColor.a;

    } else if (vBlockCategory < 1.5) {
        // ----- Water -----
        float lightLevel = max(vSkyLight, vBlockLight);

        // Desaturate in low light (original water shader behaviour)
        vec3 litColor = diffuseColor.rgb * 0.5 + diffuse + specular;
        float luminance = dot(litColor, vec3(0.299, 0.587, 0.114));
        litColor = mix(vec3(luminance), litColor, lightLevel);

        finalColor = litColor * max(lightMix * aoFactor, 0.1);
        finalAlpha = diffuseColor.a * mix(0.9, 0.4, lightLevel);

    } else {
        // ----- Glass -----
        vec3 litColor = diffuseColor.rgb + diffuse + specular;
        finalColor = litColor * max(lightMix * (1.0 - vAO * 0.1), 0.06);
        finalAlpha = diffuseColor.a; // texture alpha drives glass transparency
    }

    gl_FragColor = vec4(finalColor, finalAlpha);
}
`;
}
