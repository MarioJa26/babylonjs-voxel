export class Lod3Shader {
  public static readonly chunkVertexShader = `
    #version 300 es
    precision mediump float;

    in vec3 position;
    in vec4 faceDataA; // x,y,z origin, w = axisFace(0..5)
    in vec4 faceDataB; // x=width, y=height, z=tileX, w=tileY
    in vec4 faceDataC; // x=packedAO (unused), y=light, z=unused, w=meta (unused)

    uniform mat4 worldViewProjection;
    uniform float atlasTileSize;

    out vec2 vUV;
    flat out vec2 vUV2;
    flat out float vSkyLight;
    flat out float vBlockLight;

    vec2 cornerToUV(int corner) {
      return vec2(
        (corner == 1 || corner == 2) ? 1.0 : 0.0,
        corner >= 2 ? 1.0 : 0.0
      );
    }

    void main(void) {
      int axisFace = int(faceDataA.w + 0.5);
      int axis = axisFace >> 1;
      int isBackFace = axisFace & 1;
      int vertexId = int(position.x + 0.5);

      // Fixed triangle layout for LOD3:
      // front  = [0,2,1, 0,3,2]
      // back   = [0,1,2, 0,2,3]
      const int frontCorners[6] = int[](0, 2, 1, 0, 3, 2);
      const int backCorners[6]  = int[](0, 1, 2, 0, 2, 3);
      int corner = isBackFace == 1 ? backCorners[vertexId] : frontCorners[vertexId];

      const float invPosScale = 0.25;
      float faceWidth = faceDataB.x * invPosScale;
      float faceHeight = faceDataB.y * invPosScale;

      vec2 cornerUV = cornerToUV(corner);
      float du = cornerUV.x * faceWidth;
      float dv = cornerUV.y * faceHeight;

      int uAxis = (axis + 1) % 3;
      int vAxis = (axis + 2) % 3;

      vec3 localPosition = faceDataA.xyz * invPosScale;

      if (uAxis == 0) localPosition.x += du;
      else if (uAxis == 1) localPosition.y += du;
      else localPosition.z += du;

      if (vAxis == 0) localPosition.x += dv;
      else if (vAxis == 1) localPosition.y += dv;
      else localPosition.z += dv;

      gl_Position = worldViewProjection * vec4(localPosition, 1.0);

      vUV = cornerToUV(corner);

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
      vec2 atlasUV = vUV2 + vUV * atlasTileSize;
      vec4 tex = texture(diffuseTexture, atlasUV);

      float sun = clamp(sunLightIntensity, 0.0, 1.0);
      float skyTerm = vSkyLight * (0.15 + 0.85 * sun);
      float blockTerm = vBlockLight;
      float light = clamp(max(skyTerm, blockTerm), 0.0, 1.0);

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
      vec2 atlasUV = vUV2 + vUV * atlasTileSize;
      vec4 tex = texture(diffuseTexture, atlasUV);

      float sun = clamp(sunLightIntensity, 0.0, 1.0);
      float skyTerm = vSkyLight * (0.15 + 0.85 * sun);
      float blockTerm = vBlockLight;
      float light = clamp(max(skyTerm, blockTerm), 0.0, 1.0);

      fragColor = vec4(tex.rgb * light, tex.a);
    }
  `;
}
