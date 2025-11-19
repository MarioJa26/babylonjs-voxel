export class TransparentNormalShader {
  public static chunkFragmentShader = `
    precision highp float;
    #extension GL_OES_standard_derivatives : enable
    #extension GL_EXT_shader_texture_lod : enable

    // Varyings
    varying vec3 vPositionW;
    varying vec2 vUV;
    varying vec2 vUV2;
    varying vec2 vUV3;
    varying mat3 vTBN;

    // Uniforms
    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float atlasTileSize;
    uniform float time; // Time in seconds for animation

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;

    vec4 texture2D_with_derivatives(sampler2D atlas, vec2 tileOffset, vec2 tileUV, float tileSize) {
        vec2 atlasUV = tileOffset + tileUV * tileSize;
        vec2 dx = dFdx(tileUV) * tileSize;
        vec2 dy = dFdy(tileUV) * tileSize;
        float lod = log2(max(length(dx), length(dy)));
        return texture2DLodEXT(atlas, atlasUV, lod);
    }

    void main(void) {
        // --- Animation ---
        // Create a scrolling effect by offsetting UVs with time.
        vec2 animatedUV = vUV + vec2(time * 0.14, time * 0.3);

        vec2 tiledLocalUV = vUV * vUV3;
        vec2 singleTileUV = fract(tiledLocalUV + animatedUV); // Apply animation

        vec4 diffuseColor = texture2D_with_derivatives(diffuseTexture, vUV2, singleTileUV, atlasTileSize); 

        // Discard fragment if it's fully transparent to improve performance
       // if (diffuseColor.a < 0.01) {
        //    discard;
       // }

        vec3 normalMap = texture2D_with_derivatives(normalTexture, vUV2, singleTileUV, atlasTileSize).rgb;
        normalMap = normalize(normalMap * 2.0 - 1.0);

        vec3 worldNormal = normalize(vTBN * normalMap);

        // --- Back-face Normal Correction ---
        // gl_FrontFacing is a built-in variable. It's false if we're viewing a back-face.
        if (!gl_FrontFacing) {
            worldNormal = -worldNormal; // Flip the normal if it's a back-face
        }

        // --- Lighting Calculation ---
        vec3 normalizedLightDirection = -normalize(lightDirection);

        float diffuseIntensity = max(0.0, dot(worldNormal, normalizedLightDirection));
        vec3 diffuse = diffuseColor.rgb * diffuseIntensity;

        vec3 viewDirection = normalize(cameraPosition - vPositionW);
        vec3 halfwayDir = normalize(normalizedLightDirection + viewDirection);
        float spec = pow(max(dot(worldNormal, halfwayDir), 0.0), 32.0);
        vec3 specular = vec3(0.3) * spec;

        vec3 finalColor = diffuseColor.rgb * 0.4 + diffuse + specular;

        // Apply alpha for transparency
        gl_FragColor = vec4(finalColor, diffuseColor.a * 0.4); // Making water a bit more transparent
    }
  `;
}
