export class GlassShader {
  public static chunkFragmentShader = `
precision highp float;
#extension GL_OES_standard_derivatives : enable
#extension GL_EXT_shader_texture_lod : enable

varying vec3 vPositionW;
varying vec2 vUV;
varying vec2 vUV2;
varying vec2 vUV3;
varying mat3 vTBN;
varying vec3 vLightFactor; // From new Vertex Shader

uniform vec3 cameraPosition;
uniform vec3 lightDirection;
uniform float atlasTileSize;
uniform sampler2D diffuseTexture;
uniform sampler2D normalTexture;

void main(void) {
    vec2 tiledLocalUV = vUV * vUV3;
    vec2 singleTileUV = fract(tiledLocalUV);

    vec2 dx = dFdx(singleTileUV) * atlasTileSize;
    vec2 dy = dFdy(singleTileUV) * atlasTileSize;
    float lod = log2(max(length(dx), length(dy)));
    vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

    vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
    vec3 normalMap = normalize(texture2DLodEXT(normalTexture, atlasUV, lod).rgb * 2.0 - 1.0);
    vec3 worldNormal = normalize(vTBN * normalMap);

    // Lighting
    float diffuseIntensity = max(0.0, dot(worldNormal, normalize(lightDirection)));
    vec3 viewDirection = normalize(cameraPosition - vPositionW);
    vec3 halfwayDir = normalize(normalize(lightDirection) + viewDirection);
    
    float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 128.0);
    vec3 specular = vec3(0.5) * spec;

    // Use pre-calculated light. Added 0.05 minimum so glass is never fully invisible.
    vec3 finalColor = (diffuseColor.rgb + diffuseIntensity * 0.2 + specular) * max(vLightFactor, 0.05);

    gl_FragColor = vec4(finalColor, diffuseColor.a);
}
  `;
}
