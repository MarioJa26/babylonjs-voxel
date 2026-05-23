export class Lod4TerrainShader {
	public static readonly vertexShader = `
    #version 300 es
    precision highp float;

    in vec3 position;
    in vec4 faceDataA;
    in vec4 faceDataB;
    in vec4 faceDataC;

    uniform mat4 world;
    uniform mat4 worldViewProjection;
    uniform vec4 vFogInfos;
    uniform vec3 vFogColor;
    uniform vec3 uColorPalette[256];

    uniform GlobalUniforms {
      vec3 lightDirection;
      vec3 cameraPosition;
      float sunLightIntensity;
      float wetness;
      float time;
    };

    out vec3 vColor;
    flat out float vLight;
    out vec3 vPositionW;
    out float vFogFactor;
    out vec3 vFogColorCheap;

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

      const int cornerData[2] = int[](228, 198);
      int corner = (cornerData[isBackFace] >> (vertexId * 2)) & 3;

      float invPosScale = 0.25;
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
      vPositionW = (world * vec4(localPosition, 1.0)).xyz;

      int colorIdx = int(faceDataB.z + 0.5);
      vColor = uColorPalette[colorIdx];

      int light = int(faceDataC.y);
      float skyLight = float(light >> 4) * 0.0666666;
      float blockLight = float(light & 0xF) * 0.0666666;

      vec3 normal = vec3(0.0);
      if (axis == 0) normal.x = isBackFace == 1 ? -1.0 : 1.0;
      else if (axis == 1) normal.y = isBackFace == 1 ? -1.0 : 1.0;
      else normal.z = isBackFace == 1 ? -1.0 : 1.0;

      float sunDot = max(dot(normal, lightDirection), 0.0);
      float sunTerm = sunDot * sunLightIntensity;
      vLight = max(skyLight * (0.25 + 0.75 * sunTerm), blockLight);

      vec3 viewVec = vPositionW - cameraPosition;
      float dist = length(viewVec);
      vFogFactor = clamp(
        (vFogInfos.z - dist) / max(vFogInfos.z - vFogInfos.y, 1.0),
        0.0, 1.0
      );

      float heightFactor = clamp(
        (vPositionW.y - dist * 0.04) * 0.003,
        0.0, 1.0
      );

      vec3 atmosphereColor = mix(
        vec3(0.6, 0.75, 0.95), vec3(0.1, 0.2, 0.4), heightFactor
      ) * (sunLightIntensity * sunLightIntensity);

      vec3 viewDir = viewVec / max(dist, 1e-4);
      float skyFactor = smoothstep(0.0, 0.4, max(viewDir.y, 0.0));
      vec3 skyboxColor = mix(vec3(0.5, 0.7, 0.9), vec3(0.1, 0.3, 0.6), skyFactor);

      vec3 skyDir = -lightDirection;
      if (skyDir.y > 0.0) {
        skyboxColor = mix(skyboxColor, vec3(0.1, 0.1, 0.2), skyDir.y * 2.0);
      }

      vec3 baseFogColor = mix(vFogColor, atmosphereColor, 0.8);
      float skyBlend = clamp((dist - 1400.0) * 0.0003333, 0.0, 1.0);
      vFogColorCheap = mix(baseFogColor, skyboxColor, skyBlend);
    }
  `;

	public static readonly opaqueFragmentShader = `
    #version 300 es
    precision highp float;

    in vec3 vColor;
    flat in float vLight;
    in vec3 vPositionW;
    in float vFogFactor;
    in vec3 vFogColorCheap;

    out vec4 fragColor;

    void main(void) {
      vec3 color = vColor * vLight;
      color = mix(vFogColorCheap, color, vFogFactor);
      fragColor = vec4(color, 1.0);
    }
  `;

	public static readonly transparentFragmentShader = `
    #version 300 es
    precision highp float;

    in vec3 vColor;
    flat in float vLight;
    in vec3 vPositionW;
    in float vFogFactor;
    in vec3 vFogColorCheap;

    out vec4 fragColor;

    void main(void) {
      vec3 color = vColor * vLight;
      color = mix(vFogColorCheap, color, vFogFactor);
      fragColor = vec4(color, 1.0);
    }
  `;
}
