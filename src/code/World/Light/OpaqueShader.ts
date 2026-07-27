export const opaqueChunkVertexShader = `
        #version 300 es
        precision highp float;

        // Attributes
        in vec3 position;
        in vec4 faceDataA; // x,y,z origin/center, w = axisFace(0..5)
        in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
        in vec4 faceDataC; // x=packedAO, y=light, z=unused, w=meta
        in float chunkIndex; // index into chunkOffsets[] for merged meshes

        // Uniforms
        uniform mat4 world;
        uniform mat4 worldViewProjection;
        uniform float atlasTileSize;
        uniform float atlasMaxTiles;
        uniform vec3 chunkOffsets[64]; // per-chunk world offsets for merged meshes

        uniform GlobalUniforms {
            vec3 lightDirection;
            vec3 cameraPosition;
            float sunLightIntensity;
            float wetness;
        };

        // Varyings
        out vec2 vUV;
        flat out vec2 vUV2;
        out vec3 vPositionW;
        flat out mat3 vTBN;
        out float vAO;
        flat out float vSkyLight;
        flat out float vBlockLight;
        out vec3 vViewDir;

        int decodeCorner(int vertexId, int isBackFace, int flip) {
            const int cornerData[4] = int[](
                228, // isBackFace=0, flip=0: [0,1,2,3]
                147, // isBackFace=0, flip=1: [3,0,1,2]
                198, // isBackFace=1, flip=0: [2,1,0,3]
                177  // isBackFace=1, flip=1: [1,0,3,2]
            );
            int state = (isBackFace << 1) | flip;
            return (cornerData[state] >> (vertexId << 1)) & 3;
        }

        void decodeAtlasCorner(int axisFace, int corner, out int cornerId, out int swapUV) {
            const int cornerLookup[6] = int[](108, 57, 108, 147, 177, 228);
            cornerId = (cornerLookup[axisFace] >> (corner << 1)) & 3;
            swapUV = int(axisFace < 4);
        }

        vec2 getQuadCornerUV(int i) {
            return vec2(float((i ^ (i >> 1)) & 1), float(i >> 1));
        }

        const int U_AXIS[3] = int[](1, 2, 0);
        const int V_AXIS[3] = int[](2, 0, 1);

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
            const vec2 DIR_XZ[2] = vec2[](
                vec2(0.70710678, 0.70710678),
                vec2(0.70710678, -0.70710678)
            );
            vec2 dirXZ = DIR_XZ[diagonalVariant];

            vec3 tangent = vec3(dirXZ.x, 0.0, dirXZ.y);
            vec3 bitangent = vec3(0.0, 1.0, 0.0);

            const vec3 DIAG_NORMALS[2] = vec3[](
                vec3(0.70710678, 0.0, -0.70710678),
                vec3(-0.70710678, 0.0, -0.70710678)
            );
            vec3 normal = DIAG_NORMALS[diagonalVariant];

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

            bool diagonalEnabled = ((meta >> 4) & 1) != 0;
            int diagonalVariant = (meta >> 5) & 1;

            int corner = decodeCorner(vertexId, isBackFaceInt, flip);
            vec2 cornerUV = getQuadCornerUV(corner);

            const float invPosScale = 0.125;
            int rawDim = (meta >> 6) & 1;
            float faceWidth = rawDim == 1 ? float(faceDataB.x) : faceDataB.x * invPosScale;
            float faceHeight = rawDim == 1 ? float(faceDataB.y) : faceDataB.y * invPosScale;

            vec3 localPosition;
            vec3 N;
            vec3 T;
            vec3 B;

            if (diagonalEnabled) {
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

                vUV = cornerUV;
            } else {
                float du = float((corner ^ (corner >> 1)) & 1) * faceWidth;
                float dv = float(corner >> 1) * faceHeight;

                int uAxis = U_AXIS[axis];
                int vAxisLocal = V_AXIS[axis];

                localPosition = faceDataA.xyz * invPosScale;
                localPosition[uAxis] += du;
                localPosition[vAxisLocal] += dv;

                int atlasCornerId;
                int swapUV;
                decodeAtlasCorner(axisFace, corner, atlasCornerId, swapUV);

                float u = float((atlasCornerId ^ (atlasCornerId >> 1)) & 1);
                float v = float(atlasCornerId >> 1);

                float uDim = swapUV == 1 ? faceHeight : faceWidth;
                float vDim = swapUV == 1 ? faceWidth : faceHeight;
                vUV = vec2(u, v) * vec2(uDim, vDim);

                vec3 faceOrigin = faceDataA.xyz * invPosScale;
                vec2 uvOff = vec2(fract(faceOrigin[uAxis]), fract(faceOrigin[vAxisLocal]));
                vUV += swapUV == 1 ? uvOff.yx : uvOff;

                float fSign = isBackFace ? -1.0 : 1.0;
                vec3 normal = vec3(0.0);
                normal[axis] = fSign;

                N = normal;

                vec3 tObj = vec3(0.0);
                tObj[uAxis] = 1.0;

                T = tObj;
                B = cross(N, T) * fSign;
            }

            localPosition += chunkOffsets[int(chunkIndex + 0.5)];

            gl_Position = worldViewProjection * vec4(localPosition, 1.0);

            vUV2 = vec2(faceDataB.z, atlasMaxTiles - 1.0 - faceDataB.w) * atlasTileSize;

            vPositionW = localPosition + world[3].xyz;
            vTBN = mat3(T, B, N);
            vViewDir = normalize(cameraPosition - vPositionW);

            int packedAO = int(faceDataC.x + 0.5);
            vAO = float((packedAO >> (corner << 1)) & 3);

            int light = int(faceDataC.y + 0.5);
            vSkyLight = float((light >> 4) & 0xF) * (1.0 / 15.0);
            vBlockLight = float(light & 0xF) * (1.0 / 15.0);
        }
`;

export const opaqueChunkFragmentShader = `
    #version 300 es
    precision highp float;

    in vec2 vUV;
    flat in vec2 vUV2;
    in vec3 vPositionW;
    flat in mat3 vTBN;
    in float vAO;
    flat in float vSkyLight;
    flat in float vBlockLight;
    in vec3 vViewDir;

    uniform sampler2D diffuseTexture;
    uniform sampler2D normalTexture;
    uniform float atlasTileSize;

    out vec4 fragColor;

    uniform GlobalUniforms {
        vec3 lightDirection;
        vec3 cameraPosition;
        float sunLightIntensity;
        float wetness;
    };

    void main(void) {
        // 1. UV setup
        vec2 singleTileUV = fract(vUV);
        vec2 atlasUV = vUV2 + singleTileUV * atlasTileSize;

        vec4 diffuseColor = texture(diffuseTexture, atlasUV);
        if (diffuseColor.a < 0.01) discard;

        diffuseColor.rgb *= mix(1.0, 0.5, wetness);

        vec3 normalMap = texture(normalTexture, atlasUV).rgb;
        normalMap = normalize(normalMap * 2.0 - 1.0); 
        vec3 worldNormal = normalize(vTBN * normalMap);

        // 2. Diffuse Lighting
        float diffuseIntensity = max(0.0, dot(worldNormal, lightDirection));

        // 3. Specular — cheap Blinn-Phong approximation
        //    pow(NdotH, s) ≈ exp2(-s * 1.4427 * (1 - NdotH))
        vec3 halfwayDir = normalize(vViewDir + lightDirection);
        float shininess = mix(16.0, 128.0, wetness);
        float NH = max(dot(worldNormal, halfwayDir), 0.0);
        float spec = exp2(clamp(shininess * 1.4427 * (NH - 1.0), -126.0, 0.0));
        
        float specIntensity = mix(0.05, 2.0, wetness) * vSkyLight;
        vec3 specular = vec3(specIntensity) * spec * max(sunLightIntensity - 0.1, 0.0);

        // 4. Final Coloring
        float aoFactor = 1.0 - vAO * 0.23; 

        float skyScale = vSkyLight * 0.8 * (sunLightIntensity + 0.2);
        vec3 lightMix = clamp(skyScale + vBlockLight * vec3(0.9, 0.6, 0.2), 0.2, 1.0);
        
        fragColor = vec4((diffuseColor.rgb * (1.0 + diffuseIntensity * sunLightIntensity * vSkyLight) + specular) * lightMix * aoFactor, 1.0);
    }
`;
