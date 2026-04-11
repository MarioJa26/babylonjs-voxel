export class OpaqueShader {
  static readonly chunkVertexShader = `
        #version 300 es
        precision highp float;

        // Attributes
        in vec3 position;
        in vec4 faceDataA; // x,y,z origin/center, w = axisFace(0..5)
        in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
        in vec4 faceDataC; // x=packedAO, y=light, z=unused, w=meta

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
        flat out float vIsWater;

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

        vec2 getQuadCornerUV(int cornerIndex) {
            // 0 = bottom-left
            // 1 = bottom-right
            // 2 = top-right
            // 3 = top-left
            if (cornerIndex == 0) return vec2(0.0, 0.0);
            if (cornerIndex == 1) return vec2(1.0, 0.0);
            if (cornerIndex == 2) return vec2(1.0, 1.0);
            return vec2(0.0, 1.0);
        }

        void buildDiagonalQuad(
            vec3 centerBottom,
            float width,
            float height,
            int diagonalVariant,
            bool isBackFace,
            vec2 cornerUV,
            out vec3 outPosition,
            out vec3 outNormal,
            out vec3 outTangent,
            out vec3 outBitangent
        ) {
            // diagonalVariant == 0 => NW -> SE
            // diagonalVariant == 1 => NE -> SW
            vec2 dirXZ = diagonalVariant == 0
                ? normalize(vec2(1.0, 1.0))
                : normalize(vec2(1.0, -1.0));

            vec3 tangent = normalize(vec3(dirXZ.x, 0.0, dirXZ.y));
            vec3 bitangent = vec3(0.0, 1.0, 0.0);

            // Plane normal is perpendicular to the vertical diagonal plane
            vec3 normal = normalize(cross(bitangent, tangent));

            if (isBackFace) {
                normal = -normal;
            }

            vec3 bottomA = centerBottom - tangent * (width * 0.5);
            vec3 bottomB = centerBottom + tangent * (width * 0.5);
            vec3 topA = bottomA + bitangent * height;
            vec3 topB = bottomB + bitangent * height;

            vec3 edgeBottom = mix(bottomA, bottomB, cornerUV.x);
            vec3 edgeTop = mix(topA, topB, cornerUV.x);
            outPosition = mix(edgeBottom, edgeTop, cornerUV.y);

            outNormal = normal;
            outTangent = tangent;
            outBitangent = bitangent;
        }

void main(void) {
    int axisFace = int(faceDataA.w + 0.5);
    int axis = axisFace >> 1;
    int isBackFaceInt = axisFace & 1;
    bool isBackFace = isBackFaceInt == 1;

    int vertexId = int(position.x + 0.5);

    int meta = int(faceDataC.w + 0.5);
    int flip = meta & 1;

int materialType = (meta >> 1) & 3;
bool diagonalEnabled = ((meta >> 4) & 1) != 0;
int diagonalVariant = (meta >> 5) & 1;


    int corner = decodeCorner(vertexId, isBackFaceInt, flip);
    vec2 cornerUV = getQuadCornerUV(corner);

    const float invPosScale = 0.25;
    float faceWidth = faceDataB.x * invPosScale;
    float faceHeight = faceDataB.y * invPosScale;

    vec3 localPosition;
    vec3 N;
    vec3 T;
    vec3 B;

    if (diagonalEnabled) {
        // For diagonal quads, faceDataA.xyz encodes the CENTER of the plant at the bottom
        vec3 centerBottom = faceDataA.xyz * invPosScale;

        buildDiagonalQuad(
            centerBottom,
            faceWidth,
            faceHeight,
            diagonalVariant,
            isBackFace,
            cornerUV,
            localPosition,
            N,
            T,
            B
        );

        // For diagonal plants, use normalized 0..1 UVs across the quad once.
        // DO NOT scale UV by width=sqrt(2), otherwise the texture repeats/twists.
        vUV = cornerUV;
    } else {
        float du = (corner == 1 || corner == 2) ? faceWidth : 0.0;
        float dv = (corner >= 2) ? faceHeight : 0.0;

        int uAxis = (axis + 1) % 3;
        int vAxisLocal = (axis + 2) % 3;

        localPosition = faceDataA.xyz * invPosScale;
        if (uAxis == 0) localPosition.x += du;
        else if (uAxis == 1) localPosition.y += du;
        else localPosition.z += du;

        if (vAxisLocal == 0) localPosition.x += dv;
        else if (vAxisLocal == 1) localPosition.y += dv;
        else localPosition.z += dv;

        int atlasCornerId;
        int swapUV;
        decodeAtlasCorner(axisFace, corner, atlasCornerId, swapUV);

        float u = (atlasCornerId == 1 || atlasCornerId == 2) ? 1.0 : 0.0;
        float v = (atlasCornerId >= 2) ? 1.0 : 0.0;

        float uDim = swapUV == 1 ? faceHeight : faceWidth;
        float vDim = swapUV == 1 ? faceWidth : faceHeight;
        vUV = vec2(u, v) * vec2(uDim, vDim);

        // UV offset for sub-block faces: the face origin's fractional block position
        // tells us exactly where within the tile this face starts — no extra data needed.
        vec3 faceOrigin = faceDataA.xyz * invPosScale;
        float uvOffU = fract(faceOrigin[uAxis]);
        float uvOffV = fract(faceOrigin[vAxisLocal]);
        vUV += vec2(
            swapUV == 1 ? uvOffV : uvOffU,
            swapUV == 1 ? uvOffU : uvOffV
        );

        vec3 normal = vec3(0.0);
        if (axis == 0) normal.x = isBackFace ? -1.0 : 1.0;
        else if (axis == 1) normal.y = isBackFace ? -1.0 : 1.0;
        else normal.z = isBackFace ? -1.0 : 1.0;

        N = normalize(mat3(world) * normal);

        float isX = axis == 0 ? 1.0 : 0.0;
        float isY = axis == 1 ? 1.0 : 0.0;
        vec3 tObj = vec3(1.0 - isX - isY, isX, isY);

        float handedness = sign(normal.x + normal.y + normal.z);
        T = normalize(mat3(world) * tObj);
        B = normalize(cross(N, T) * handedness);
    }

    gl_Position = worldViewProjection * vec4(localPosition, 1.0);

    float maxTiles = floor(1.0 / atlasTileSize + 0.5);
    vUV2 = vec2(faceDataB.z, maxTiles - 1.0 - faceDataB.w) * atlasTileSize;

    vPositionW = (world * vec4(localPosition, 1.0)).xyz;
    vTBN = mat3(T, B, N);

    int packedAO = int(faceDataC.x + 0.5);
    vAO = float((packedAO >> (corner * 2)) & 3);

    int light = int(faceDataC.y + 0.5);
    vSkyLight = float(light >> 4) * 0.0666666;
    vBlockLight = float(light & 0xF) * 0.0666666;

    vMaterialType = float(materialType);

    // Opaque/shared vertex path no longer uses meta bit 2 as "isWater".
    // Keep it defined for compatibility with shaders that still expect the varying.
    vIsWater = 0.0;
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

        // 4. Specular
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
        
        vec3 lightMix = clamp((vSkyLight * vSkyColor) + (vBlockLight * vBlockColor), 0.2, 1.0);
        
        vec3 finalColor = (diffuseColor.rgb + diffuse + specular) * lightMix * aoFactor;

        fragColor = vec4(finalColor, diffuseColor.a);
    }
`;
}
