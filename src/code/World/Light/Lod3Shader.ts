export class Lod3Shader {
  public static readonly chunkVertexShader = `
    #version 300 es
    precision mediump float;

    in vec3 position;
    in vec4 faceDataA; // x,y,z origin, w = axisFace(0..5)
    in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
    in vec4 faceDataC; // x=packedAO, y=light, z=unused, w=meta

    uniform mat4 worldViewProjection;
    uniform float atlasTileSize;

    out vec2 vUV;
    flat out vec2 vUV2;
    flat out float vSkyLight;
    flat out float vBlockLight;

    int decodeCorner(int vertexId, int isBackFace, int flip) {
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
      const int cornerLookup[6] = int[](108, 57, 108, 147, 177, 228);
      cornerId = (cornerLookup[axisFace] >> (corner << 1)) & 3;
      swapUV = int(axisFace < 4);
    }

    void main(void) {
      int axisFace = int(faceDataA.w + 0.5);
      int axis = axisFace >> 1;
      int vertexId = int(position.x + 0.5);

      int meta = int(faceDataC.w);
      int flip = meta & 1;
      int corner = decodeCorner(vertexId, axisFace & 1, flip);

      const float invPosScale = 0.25;
      float faceWidth = faceDataB.x * invPosScale;
      float faceHeight = faceDataB.y * invPosScale;

      float du = (corner == 1 || corner == 2) ? faceWidth : 0.0;
      float dv = (corner >= 2) ? faceHeight : 0.0;

      int uAxis = (axis + 1) % 3;
      int vAxisAxis = (axis + 2) % 3;

      vec3 localPosition = faceDataA.xyz * invPosScale;
      if (uAxis == 0) localPosition.x += du;
      else if (uAxis == 1) localPosition.y += du;
      else localPosition.z += du;

      if (vAxisAxis == 0) localPosition.x += dv;
      else if (vAxisAxis == 1) localPosition.y += dv;
      else localPosition.z += dv;

      gl_Position = worldViewProjection * vec4(localPosition, 1.0);

      int atlasCornerId;
      int swapUV;
      decodeAtlasCorner(axisFace, corner, atlasCornerId, swapUV);
      float u = (atlasCornerId == 1 || atlasCornerId == 2) ? 1.0 : 0.0;
      float v = (atlasCornerId >= 2) ? 1.0 : 0.0;

      // LOD3: force one full tile per face (no size-based tiling, no origin offset).
      vUV = vec2(u, v);

      float maxTiles = floor(1.0 / atlasTileSize + 0.5);
      vUV2 = vec2(faceDataB.z, maxTiles - 1.0 - faceDataB.w) * atlasTileSize;

      int light = int(faceDataC.y);
      vSkyLight = float(light >> 4) * 0.0666666;
      vBlockLight = float(light & 0xF) * 0.0666666;
    }
  `;

  public static readonly opaqueFragmentShader = `
    #version 300 es
    precision mediump float;

    in vec2 vUV;
    flat in vec2 vUV2;
    flat in float vSkyLight;
    flat in float vBlockLight;

    uniform sampler2D diffuseTexture;
    uniform float atlasTileSize;
    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
    };

    out vec4 fragColor;

    void main(void) {
      vec2 atlasUV = vUV2 + fract(vUV) * atlasTileSize;
      vec4 tex = texture(diffuseTexture, atlasUV);
      float sun = clamp(sunLightIntensity, 0.0, 1.0);
      float skyTerm = vSkyLight * (0.15 + 0.85 * sun);
      float blockTerm = vBlockLight;
      float light = clamp(max(skyTerm, blockTerm), 0.00, 1.0);
      fragColor = vec4(tex.rgb * light, 1.0);
    }
  `;

  public static readonly transparentFragmentShader = `
    #version 300 es
    precision mediump float;

    in vec2 vUV;
    flat in vec2 vUV2;
    flat in float vSkyLight;
    flat in float vBlockLight;

    uniform sampler2D diffuseTexture;
    uniform float atlasTileSize;
    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
    };

    out vec4 fragColor;

    void main(void) {
      vec2 atlasUV = vUV2 + fract(vUV) * atlasTileSize;
      vec4 tex = texture(diffuseTexture, atlasUV);
      float sun = clamp(sunLightIntensity, 0.0, 1.0);
      float skyTerm = vSkyLight * (0.15 + 0.85 * sun);
      float blockTerm = vBlockLight;
      float light = clamp(max(skyTerm, blockTerm), 0.00, 1.0);
      fragColor = vec4(tex.rgb * light, tex.a);
    }
  `;
}
