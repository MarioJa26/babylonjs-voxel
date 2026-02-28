export class DistantTerrainShader {
  static readonly distantTerrainVertexShader = `
        precision lowp float;
        attribute vec3 position;
        attribute vec3 normal;

        uniform mat4 world;
        uniform mat4 worldViewProjection;

        varying vec3 vNormal;
        varying vec3 vPositionW;

        void main() {
            gl_Position = worldViewProjection * vec4(position, 1.0);
            vPositionW = (world * vec4(position, 1.0)).xyz;
            vNormal = normalize(mat3(world) * normal);
        }
    `;

  static readonly distantTerrainFragmentShader = `
        precision highp float;
        varying vec3 vNormal;
        varying vec3 vPositionW;

        uniform vec3 lightDirection;
        uniform float sunLightIntensity;
        uniform sampler2D diffuseTexture;
        uniform sampler2D tileLookupTexture;
        uniform float atlasTileSize;
        uniform float textureScale;
        uniform float useTexture;
        uniform float tileGridResolution;
        uniform vec2 gridOriginWorld;
        uniform float gridWorldStep;
        
        uniform vec4 vFogInfos;
        uniform vec3 vFogColor;
        uniform vec3 cameraPosition;

        const vec3 DEEP_BLUE = vec3(0.1, 0.2, 0.4);
        const vec3 LIGHT_BLUE = vec3(0.6, 0.75, 0.95);
        const vec3 DARK_SKY = vec3(0.1, 0.1, 0.2);
        const vec3 MID_SKY = vec3(0.5, 0.7, 0.9);
        const vec3 DAY_SKY = vec3(0.1, 0.3, 0.6);
        const float HEIGHT_SCALE = 0.003;
        const float HEIGHT_OFFSET = 0.04;
        const float SKYBLEND_DIST = 1400.0;
        const float SKYBLEND_FACTOR = 0.0003333;

        vec3 sampleAtlasTile(vec2 tile, vec2 worldUV) {
            vec2 baseUV = vec2(
                tile.x * atlasTileSize,
                1.0 - ((tile.y + 1.0) * atlasTileSize)
            );
            vec2 atlasUV = baseUV + fract(worldUV) * atlasTileSize;
            return texture2D(diffuseTexture, atlasUV).rgb;
        }

        vec2 readTopTileFromLookup() {
            vec2 grid = (vPositionW.xz - gridOriginWorld) / gridWorldStep;
            vec2 nearest = clamp(
                floor(grid + vec2(0.5)),
                vec2(0.0),
                vec2(tileGridResolution - 1.0)
            );
            vec2 lookupUV = (nearest + vec2(0.5)) / tileGridResolution;
            return floor(texture2D(tileLookupTexture, lookupUV).rg * 255.0 + vec2(0.5));
        }

        vec3 getAtmosphereColor(float heightFactor) {
            return mix(LIGHT_BLUE, DEEP_BLUE, heightFactor) * (sunLightIntensity * sunLightIntensity);
        }

        vec3 getSkyboxColor(float viewDirY) {
            float skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
            vec3 skyboxColor = mix(MID_SKY, DAY_SKY, skyFactor);
            if (lightDirection.y > 0.0) {
                skyboxColor = mix(skyboxColor, DARK_SKY, lightDirection.y * 2.0);
            }
            return skyboxColor;
        }

        void main() {
            vec3 worldNormal = normalize(vNormal);
            float ndotl = max(0.0, dot(worldNormal, -lightDirection));

            vec3 albedo = vec3(0.5);
            if (useTexture > 0.5) {
                vec2 tile = readTopTileFromLookup();
                vec2 worldUV = vPositionW.xz / textureScale;
                albedo = sampleAtlasTile(tile, worldUV);
            }
             
            vec3 skyColor = vec3(0.8) * (sunLightIntensity + 0.2);
            vec3 finalColor = albedo * (ndotl * sunLightIntensity * 0.6 + skyColor * 0.6);
             
            vec3 viewVec = vPositionW - cameraPosition;
            float dist = length(viewVec);
            float fogFactor = clamp((vFogInfos.z - dist) / (vFogInfos.z - vFogInfos.y), 0.0, 1.0);
            
            float heightFactor = clamp((vPositionW.y - dist * HEIGHT_OFFSET) * HEIGHT_SCALE, 0.0, 1.0);
            vec3 atmosphereColor = getAtmosphereColor(heightFactor);
            vec3 baseFogColor = mix(vFogColor, atmosphereColor, 0.8);

            float viewDirY = viewVec.y / dist;
            vec3 skyboxColor = getSkyboxColor(viewDirY);
            
            float skyBlend = clamp((dist - SKYBLEND_DIST) * SKYBLEND_FACTOR, 0.0, 1.0);
            vec3 effectiveFogColor = mix(baseFogColor, skyboxColor, skyBlend);
            
            vec3 colorWithFog = mix(effectiveFogColor, finalColor, fogFactor);

            gl_FragColor = vec4(colorWithFog, 1.0);
        }
    `;

  static readonly distantWaterVertexShader = `
        precision highp float;
        attribute vec3 position;
        uniform mat4 world;
        uniform mat4 worldViewProjection;
        varying vec3 vPositionW;

        void main() {
            gl_Position = worldViewProjection * vec4(position, 1.0);
            vPositionW = (world * vec4(position, 1.0)).xyz;
        }
    `;

  static readonly distantWaterFragmentShader = `
        precision highp float;
        varying vec3 vPositionW;

        uniform vec3 lightDirection;
        uniform float sunLightIntensity;
        uniform vec4 vFogInfos;
        uniform vec3 vFogColor;
        uniform vec3 cameraPosition;

        const vec3 WATER_COLOR = vec3(0.0, 0.1, 0.3);
        const vec3 DEEP_BLUE = vec3(0.1, 0.2, 0.4);
        const vec3 LIGHT_BLUE = vec3(0.6, 0.75, 0.95);
        const vec3 DARK_SKY = vec3(0.1, 0.1, 0.2);
        const vec3 MID_SKY = vec3(0.5, 0.7, 0.9);
        const vec3 DAY_SKY = vec3(0.1, 0.3, 0.6);
        const float SPEC_POWER = 64.0;
        const float HEIGHT_SCALE = 0.003;
        const float HEIGHT_OFFSET = 0.3;
        const float SKYBLEND_DIST = 7000.0;
        const float SKYBLEND_FACTOR = 0.0003333;

        vec3 getAtmosphereColor(float heightFactor) {
            return mix(LIGHT_BLUE, DEEP_BLUE, heightFactor) * (sunLightIntensity * sunLightIntensity);
        }

        vec3 getSkyboxColor(float viewDirY) {
            float skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
            vec3 skyboxColor = mix(MID_SKY, DAY_SKY, skyFactor);
            if (lightDirection.y > 0.0) {
                skyboxColor = mix(skyboxColor, DARK_SKY, lightDirection.y * 2.0);
            }
            return skyboxColor;
        }

        void main() {
            vec3 normal = vec3(0.0, 1.0, 0.0);
            
            vec3 viewVec = vPositionW - cameraPosition;
            float dist = length(viewVec);
            vec3 viewDir = -viewVec / dist;
            
            vec3 reflectDir = reflect(lightDirection, normal);
            float spec = pow(max(dot(viewDir, reflectDir), 0.0), SPEC_POWER);
            vec3 specular = vec3(spec * sunLightIntensity);
            
            vec3 finalColor = WATER_COLOR * (sunLightIntensity * 0.8 + 0.1) + specular;

            float fogFactor = clamp((vFogInfos.z - dist) / (vFogInfos.z - vFogInfos.y), 0.0, 1.0);
            
            float heightFactor = clamp((vPositionW.y - dist * HEIGHT_OFFSET) * HEIGHT_SCALE, 0.0, 1.0);
            vec3 atmosphereColor = getAtmosphereColor(heightFactor);
            vec3 baseFogColor = mix(vFogColor, atmosphereColor, 0.8);

            vec3 skyboxColor = getSkyboxColor(viewDir.y);
            
            float skyBlend = clamp((dist - SKYBLEND_DIST) * SKYBLEND_FACTOR, 0.0, 1.0);
            vec3 effectiveFogColor = mix(baseFogColor, skyboxColor, skyBlend);

            vec3 colorWithFog = mix(effectiveFogColor, finalColor, fogFactor);

            gl_FragColor = vec4(colorWithFog, 1.0);
        }
    `;
}
