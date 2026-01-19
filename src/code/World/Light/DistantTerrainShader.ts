export class DistantTerrainShader {
  static readonly distantTerrainVertexShader = `
        precision lowp float;
        attribute vec3 position;
        attribute vec3 normal;
        attribute vec3 color;

        uniform mat4 world;
        uniform mat4 worldViewProjection;

        varying vec3 vColor;
        varying vec3 vNormal;
        varying vec3 vPositionW;

        void main() {
            gl_Position = worldViewProjection * vec4(position, 1.0);
            vPositionW = (world * vec4(position, 1.0)).xyz;
            vNormal = normalize(mat3(world) * normal);
            vColor = color;
        }
    `;

  static readonly distantTerrainFragmentShader = `
        precision highp float;
        varying vec3 vColor;
        varying vec3 vNormal;
        varying vec3 vPositionW;

        uniform vec3 lightDirection;
        uniform float sunLightIntensity;
        
        uniform vec4 vFogInfos;
        uniform vec3 vFogColor;
        uniform vec3 cameraPosition;

        void main() {
            float ndotl = max(0.0, dot(vNormal, -lightDirection));
            
            vec3 skyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
            vec3 finalColor = vColor * (ndotl * sunLightIntensity * 0.6 + skyColor * 0.6);
            
            vec3 viewVec = vPositionW - cameraPosition;
            float dist = length(viewVec);
            float fogFactor = clamp((vFogInfos.z - dist) / (vFogInfos.z - vFogInfos.y), 0.0, 1.0);
            
            // Atmospheric perspective: Blue hue gradient based on height
            // Lighter at the bottom, darker at the peaks
            // Adjusted to start gradient from -20 to cover valleys/ocean floor
            float heightFactor = clamp((vPositionW.y - dist * 0.04) / 300.0, 0.0, 1.0);
            vec3 deepBlue = vec3(0.1, 0.2, 0.4);
            vec3 lightBlue = vec3(0.6, 0.75, 0.95);
            
            vec3 atmosphereColor = mix(lightBlue, deepBlue, heightFactor) * (sunLightIntensity * sunLightIntensity);
            vec3 baseFogColor = mix(vFogColor, atmosphereColor, 0.8);

            // Blend into skybox color at distance
            float viewDirY = viewVec.y / dist;
            float skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
            vec3 skyboxColor = mix(vec3(0.5, 0.7, 0.9), vec3(0.1, 0.3, 0.6), skyFactor);
            if (lightDirection.y > 0.0) {
                skyboxColor = mix(skyboxColor, vec3(0.1, 0.1, 0.2), lightDirection.y * 2.0);
            }
            
            float skyBlend = clamp((dist - 1400.0) * 0.0003, 0.0, 1.0);
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

        void main() {
            vec3 normal = vec3(0.0, 1.0, 0.0);
            
            vec3 viewVec = vPositionW - cameraPosition;
            float dist = length(viewVec);
            vec3 viewDir = -viewVec / dist;
            vec3 reflectDir = reflect(lightDirection, normal);
            float spec = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);
            vec3 specular = vec3(1.0) * spec * sunLightIntensity;
            
            vec3 waterColor = vec3(0.0, 0.1, 0.3);
            vec3 finalColor = waterColor * (sunLightIntensity * 0.8 + 0.1) + specular;

            float fogFactor = clamp((vFogInfos.z - dist) / (vFogInfos.z - vFogInfos.y), 0.0, 1.0);
            
            float heightFactor = clamp((vPositionW.y - dist * 0.3) / 300.0, 0.0, 1.0);
            vec3 deepBlue = vec3(0.1, 0.2, 0.4);
            vec3 lightBlue = vec3(0.6, 0.75, 0.95);
            vec3 atmosphereColor = mix(lightBlue, deepBlue, heightFactor) * (sunLightIntensity * sunLightIntensity);
            vec3 baseFogColor = mix(vFogColor, atmosphereColor, 0.8);

            // Blend into skybox color at distance

            float skyFactor = smoothstep(0.0, 0.4, max(viewDir.y, 0.0));
            vec3 skyboxColor = mix(vec3(0.5, 0.7, 0.9), vec3(0.1, 0.3, 0.6), skyFactor);
            if (lightDirection.y > 0.0) {
                skyboxColor = mix(skyboxColor, vec3(0.1, 0.1, 0.2), lightDirection.y * 2.0);
            }
            
            float skyBlend = clamp((dist - 7000.0) * 0.0003333, 0.0, 1.0);
            vec3 effectiveFogColor = mix(baseFogColor, skyboxColor, skyBlend);

            vec3 colorWithFog = mix(effectiveFogColor, finalColor, fogFactor);

            gl_FragColor = vec4(colorWithFog, 1.0);
        }
    `;
}
