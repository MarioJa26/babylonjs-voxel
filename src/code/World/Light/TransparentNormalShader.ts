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
    varying vec2 vScreenSize;

    // Uniforms
    uniform vec3 cameraPosition;
    uniform vec3 lightDirection;
    uniform float atlasTileSize;
    uniform float time; // Time in seconds for animation

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
    uniform sampler2D depthSampler;

    vec4 texture2D_with_derivatives(sampler2D atlas, vec2 tileOffset, vec2 tileUV, float tileSize) {
        vec2 atlasUV = tileOffset + tileUV * tileSize;
        vec2 dx = dFdx(tileUV) * tileSize;
        vec2 dy = dFdy(tileUV) * tileSize;
        float lod = log2(max(length(dx), length(dy)));
        return texture2DLodEXT(atlas, atlasUV, lod);
    }

    // Function to linearize depth value from depth map
    float linearizeDepth(float depth, float zNear, float zFar) {
        float z = depth * 2.0 - 1.0; // Back to NDC
        return (2.0 * zNear * zFar) / (zFar + zNear - z * (zFar - zNear));
    }

    uniform vec2 cameraPlanes; // Represents camera.minZ and camera.maxZ

    void main(void) {
        // --- Animation ---
        // Create a scrolling effect by offsetting UVs with time.

        vec2 tiledLocalUV = vUV * vUV3;


        // Get the geometric world normal (the 3rd column of the TBN matrix).
        vec3 geometricWorldNormal = vTBN[2];

        // If rendering a front-face (top of water), move in one direction.
        // If rendering a back-face (bottom of water), move in the opposite direction.
        if (geometricWorldNormal.y > 0.0) { // Top face
            tiledLocalUV -= vec2(-time * 0.3, time * 0.4);
        } else { // Bottom face
            tiledLocalUV += vec2(time * 0.3, time * 0.4);
        }
        vec2 singleTileUV = fract(tiledLocalUV);

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

        // --- Depth-based Transparency ---
        // Get screen UVs from gl_FragCoord
        vec2 screenUV = gl_FragCoord.xy / vScreenSize;
        
        // Read depth of the opaque geometry behind the water
        float sceneDepth = texture2D(depthSampler, screenUV).r; 
        
        // Linearize depths to get a real-world distance
        float linearSceneDepth = linearizeDepth(sceneDepth, cameraPlanes.x, cameraPlanes.y);
        float linearWaterDepth = linearizeDepth(gl_FragCoord.z, cameraPlanes.x, cameraPlanes.y);
        
        float waterThickness = linearSceneDepth - linearWaterDepth;
        float fogFactor = clamp(waterThickness * 2.2, 0.0, 1.0); // Adjust 0.2 to control how quickly water becomes opaque

        // Apply alpha for transparency
        gl_FragColor = vec4(finalColor, mix(diffuseColor.a * 0.4, 1.0, fogFactor));
    }
  `;
}
