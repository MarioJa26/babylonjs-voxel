export class VoxelImpostorShader {
	public static readonly vertexShader = `
    #version 300 es
    precision highp float;

    in vec3 position;

    uniform mat4 world;
    uniform mat4 worldViewProjection;
    uniform vec3 uCameraPosition;

    out vec3 vWorldPos;
    out vec3 vRayDir;

    void main(void) {
      vec4 wPos = world * vec4(position, 1.0);
      vWorldPos = wPos.xyz;
      vRayDir = normalize(wPos.xyz - uCameraPosition);
      gl_Position = worldViewProjection * vec4(position, 1.0);
    }
  `;

	public static readonly fragmentShader = `
    #version 300 es
    precision highp float;

    in vec3 vWorldPos;
    in vec3 vRayDir;

    out vec4 fragColor;

    uniform vec3 uCameraPosition;
    uniform vec3 uRegionWorldMin;
    uniform vec3 uRegionWorldMax;
    uniform vec3 uLightDirection;
    uniform float uSunLightIntensity;
    uniform vec4 uFogInfos;
    uniform vec3 uFogColor;

    uniform sampler2D uVoxelPool;
    uniform sampler2D uIndirectionTable;

    // Indirection texture layout:
    //   width  = uIndirectionXZ  (covers rx mod XZ)
    //   height = uIndirectionXZ * Y_LAYERS  (rz mod XZ stacked per Y slice)
    //   texY   = (rz mod XZ) + (ry - uIndirectionRyBase) * uIndirectionXZ
    uniform float uIndirectionXZ;
    uniform float uIndirectionTotalHeight;
    uniform float uIndirectionRyBase;

    uniform vec2 uVoxelPoolSize;
    uniform float uBrickPoolSize;
    uniform float uBrickResolution;
    uniform float uRegionVoxelSize;

    uniform vec3 uBlockColors[256];

    const int MAX_STEPS = 128;
    const float MIN_STEP = 4.0;

    float sampleVoxel(vec3 worldPos) {
      vec3 rel = worldPos - uRegionWorldMin;

      // Which region cell (rx, ry, rz) does this world position fall in?

float regionX = floor(worldPos.x / uRegionVoxelSize);
float regionY = floor(worldPos.y / uRegionVoxelSize);
float regionZ = floor(worldPos.z / uRegionVoxelSize);


      // Sub-voxel position within the brick.
vec3 regionMin = vec3(regionX, regionY, regionZ) * uRegionVoxelSize;
vec3 brickRel = (worldPos - regionMin) / uRegionVoxelSize * uBrickResolution;


      // Map (rx, ry, rz) to the indirection texture using the same tiling
      // scheme the CPU writes: texX = rx mod XZ, texY = rz mod XZ + ySlot*XZ.
      float ySlot = regionY - uIndirectionRyBase;
      if (ySlot < 0.0 || ySlot >= (uIndirectionTotalHeight / uIndirectionXZ)) {
        return 0.0;
      }

      float texX = mod(regionX, uIndirectionXZ);
      float texY = mod(regionZ, uIndirectionXZ) + ySlot * uIndirectionXZ;

      vec2 lookupUV = (vec2(texX, texY) + 0.5) / vec2(uIndirectionXZ, uIndirectionTotalHeight);
      vec4 indirectionSample = texture(uIndirectionTable, lookupUV);
      float encoded = round(indirectionSample.r * 255.0) + round(indirectionSample.g * 255.0) * 256.0;
      float brickIndex = encoded - 1.0;

      if (brickIndex < 0.5) {
        return 0.0;
      }

      float voxelIdx = brickIndex * uBrickPoolSize +
        floor(brickRel.x) +
        floor(brickRel.y) * uBrickResolution +
        floor(brickRel.z) * uBrickResolution * uBrickResolution;

      float poolWidth = uVoxelPoolSize.x;
      float px = mod(voxelIdx, poolWidth);
      float py = floor(voxelIdx / poolWidth);
      vec2 uv = (vec2(px, py) + 0.5) / uVoxelPoolSize;

       return texture(uVoxelPool, uv).r * 255.0;
    }

    void main(void) {
      vec3 rayOrigin = uCameraPosition;
      vec3 rayDir = normalize(vRayDir);

      vec3 invDir = 1.0 / rayDir;
      vec3 t0 = (uRegionWorldMin - rayOrigin) * invDir;
      vec3 t1 = (uRegionWorldMax - rayOrigin) * invDir;
      vec3 tMin = min(t0, t1);
      vec3 tMax = max(t0, t1);
      float tNear = max(max(tMin.x, tMin.y), tMin.z);
      float tFar = min(min(tMax.x, tMax.y), tMax.z);
      if (tNear > tFar) {
        discard;
      }
      float t = max(tNear, 0.0);
      vec3 hitColor = vec3(0.5);
      bool hit = false;

      for (int i = 0; i < MAX_STEPS; i++) {
        vec3 pos = rayOrigin + rayDir * t;

        if (t > tFar) {
          break;
        }

        float voxel = sampleVoxel(pos);

        if (voxel > 0.01) {
          float NdotL = max(dot(normalize(vec3(0.0, 1.0, 0.0)), uLightDirection), 0.0);
          float light = 0.35 + NdotL * uSunLightIntensity * 0.65;
          hitColor = uBlockColors[int(clamp(voxel + 0.5, 0.0, 255.0))] * light;
          hit = true;
          break;
        }

        t += MIN_STEP;
      }

      if (!hit) {
        discard;
      }

      vec3 viewVec = vWorldPos - uCameraPosition;
      float dist = length(viewVec);
      float fogFactor = clamp(
        (uFogInfos.z - dist) / max(uFogInfos.z - uFogInfos.y, 1.0),
        0.0, 1.0
      );

      vec3 finalColor = mix(uFogColor, hitColor, fogFactor);
      fragColor = vec4(finalColor, 1.0);
    }
  `;
}
