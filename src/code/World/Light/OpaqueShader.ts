export class OpaqueShader {
  static readonly chunkVertexShader = `
        #version 300 es
        precision highp float;

        // Attributes
        in vec3 position;
        in vec4 faceDataA; // x,y,z origin, w = axisFace(0..5)
        in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
        in vec4 faceDataC; // x=packedAO, y=light, z=materialType, w=flip

        // Uniforms
        uniform mat4 world;
        uniform mat4 worldViewProjection;
        uniform float atlasTileSize;
        uniform float maxAtlasTiles;

        uniform GlobalUniforms {
            vec3 lightDirection;
            vec3 cameraPosition;
            float sunLightIntensity;
            float wetness;
            float time;
        };

        // Varyings
        out vec2 vUV;
        flat out vec2 vUV2;
        out vec3 vPositionW;
        out mat3 vTBN;
        out float vAO;
        flat out float vSkyLight;
        flat out float vBlockLight;
        flat out float vMaterialType;

        int decodeCorner(int vertexId, int isBackFace, int flip) {
            // Packed corner IDs for 6 vertices (2 bits each) for 4 states (isBackFace/flip)
            const int cornerData[4] = int[](
                2840, // isBackFace=0, flip=0: [0,2,1,0,3,2]
                2908, // isBackFace=0, flip=1: [0,3,1,1,3,2]
                3620, // isBackFace=1, flip=0: [0,1,2,0,2,3]
                3700  // isBackFace=1, flip=1: [0,1,3,1,2,3]
            );
            int state = (isBackFace << 1) | flip;
            return (cornerData[state] >> (vertexId * 2)) & 3;
        }

        void decodeAtlasCorner(int axisFace, int corner, out int cornerId, out int swapUV) {
            // Packed corner mappings for faces 0-5 (2 bits per corner)
            const int cornerLookup[6] = int[](108, 57, 108, 147, 177, 228);
            cornerId = (cornerLookup[axisFace] >> (corner << 1)) & 3;
            swapUV = int(axisFace < 4);
        }

void main(void) {
    int axisFace = int(faceDataA.w + 0.5);
    int axis = axisFace >> 1;
    int isBackFace = axisFace & 1;
    int vertexId = int(position.x + 0.5);

    int meta = int(faceDataC.w);
    int flip = meta & 1;
    int materialType = (meta >> 1) & 1;

    int corner = decodeCorner(vertexId, isBackFace, flip);
    float du = (corner == 1 || corner == 2) ? faceDataB.x : 0.0;
    float dv = (corner >= 2) ? faceDataB.y : 0.0;

    int uAxis = (axis + 1) % 3;
    int vAxis = (axis + 2) % 3;

    vec3 localPosition = faceDataA.xyz;
    if (uAxis == 0) localPosition.x += du;
    else if (uAxis == 1) localPosition.y += du;
    else localPosition.z += du;

    if (vAxis == 0) localPosition.x += dv;
    else if (vAxis == 1) localPosition.y += dv;
    else localPosition.z += dv;

    gl_Position = worldViewProjection * vec4(localPosition, 1.0);

    int atlasCornerId;
    int swapUV;
    decodeAtlasCorner(axisFace, corner, atlasCornerId, swapUV);
    float u = (atlasCornerId == 1 || atlasCornerId == 2) ? 1.0 : 0.0;
    float v = (atlasCornerId >= 2) ? 1.0 : 0.0;

    float uDim = swapUV == 1 ? faceDataB.y : faceDataB.x;
    float vDim = swapUV == 1 ? faceDataB.x : faceDataB.y;
    vUV = vec2(u, v) * vec2(uDim, vDim);

    float maxTiles = floor(1.0 / atlasTileSize + 0.5);
    vUV2 = vec2(faceDataB.z, maxTiles - 1.0 - faceDataB.w) * atlasTileSize;
    
    vPositionW = (world * vec4(localPosition, 1.0)).xyz;
    
    vec3 normal = vec3(0.0);
    if (axis == 0) normal.x = isBackFace == 1 ? -1.0 : 1.0;
    else if (axis == 1) normal.y = isBackFace == 1 ? -1.0 : 1.0;
    else normal.z = isBackFace == 1 ? -1.0 : 1.0;

    vec3 N = normalize(mat3(world) * normal);
    
    float isX = axis == 0 ? 1.0 : 0.0;
    float isY = axis == 1 ? 1.0 : 0.0;
    vec3 tObj = vec3(1.0 - isX - isY, isX, isY);

    float handedness = sign(normal.x + normal.y + normal.z);
    vec3 T = normalize(mat3(world) * tObj);
    vec3 B = normalize(cross(N, T) * handedness);
    vTBN = mat3(T, B, N);

    int packedAO = int(faceDataC.x);
    // Optimized AO unpacking using bitwise shift
    vAO = float((packedAO >> (corner * 2)) & 3);

    int light = int(faceDataC.y);
    vSkyLight = float(light >> 4) * 0.0666666;
    vBlockLight = float(light & 0xF) * 0.0666666;
    vMaterialType = float(materialType);
}
`;

  static readonly chunkFragmentShader = `
    #version 300 es
    precision highp float;

    in vec2 vUV;
    flat in vec2 vUV2;
    in vec3 vPositionW;
    in mat3 vTBN;
    in float vAO;
    flat in float vSkyLight;
    flat in float vBlockLight;

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
    uniform float atlasTileSize;

    out vec4 fragColor;

    uniform GlobalUniforms {
        vec3 lightDirection;
        vec3 cameraPosition;
        float sunLightIntensity;
        float wetness;
        float time;
    };

    void main(void) {
        // 1. UV setup
        vec2 singleTileUV = fract(vUV);
        vec2 dx = dFdx(vUV) * atlasTileSize;
        vec2 dy = dFdy(vUV) * atlasTileSize;
        float lod = log2(max(length(dx), length(dy)));
        vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

        // 2. Sampling
        vec4 diffuseColor = textureLod(diffuseTexture, atlasUV, lod);
        diffuseColor.rgb *= mix(1.0, 0.5, wetness);

        vec3 normalMap = textureLod(normalTexture, atlasUV, lod).rgb;
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

        vec3 vSkyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
        vec3 vBlockColor = vec3(0.9, 0.6, 0.2);
        
        // Colors are now provided by varyings vSkyColor and vBlockColor
        vec3 lightMix = clamp((vSkyLight * vSkyColor) + (vBlockLight * vBlockColor), 0.2, 1.0);
        
        vec3 finalColor = (diffuseColor.rgb + diffuse + specular) * lightMix * aoFactor;

        fragColor = vec4(finalColor, diffuseColor.a);
    }
`;
}
