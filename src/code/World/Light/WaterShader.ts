export class WaterShader {
  public static chunkFragmentShader = `
    precision highp float;
#extension GL_OES_standard_derivatives : enable
#extension GL_EXT_shader_texture_lod : enable

varying vec3 vPositionW;
varying vec2 vUV;
varying vec2 vUV2;
varying vec2 vUV3;
varying mat3 vTBN;
varying vec3 vLightFactor;

uniform vec3 cameraPosition;
uniform vec3 lightDirection;
uniform float atlasTileSize;
uniform float time;
uniform sampler2D diffuseTexture;
uniform sampler2D normalTexture;

void main(void) {
    // Animation logic kept
    vec2 tiledLocalUV = (vUV * vUV3) - vec2(-time * 0.1, time * 0.15);
    vec2 singleTileUV = fract(tiledLocalUV);

    vec2 dx = dFdx(singleTileUV) * atlasTileSize;
    vec2 dy = dFdy(singleTileUV) * atlasTileSize;
    float lod = log2(max(length(dx), length(dy)));
    vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

    vec4 diffuseColor = texture2DLodEXT(diffuseTexture, atlasUV, lod);
    vec3 normalMap = normalize(texture2DLodEXT(normalTexture, atlasUV, lod).rgb * 2.0 - 1.0);
    vec3 worldNormal = normalize(vTBN * normalMap);

    // Lighting
    vec3 viewDirection = normalize(cameraPosition - vPositionW);
    vec3 halfwayDir = normalize(normalize(lightDirection) + viewDirection);
    float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 32.0);
    
    // Water-specific darkening and light mixing
    vec3 litColor = (diffuseColor.rgb * 0.6) + (vec3(0.4) * spec);
    vec3 finalColor = litColor * max(vLightFactor, 0.1);

    // Use the brightness of vLightFactor to determine water opacity
    float brightness = (vLightFactor.r + vLightFactor.g + vLightFactor.b) / 3.0;
    // This keeps alpha between 95% and 80% of the texture's original alpha
    gl_FragColor = vec4(finalColor, diffuseColor.a * mix(0.95, 0.8, brightness));
}
  `;
}
