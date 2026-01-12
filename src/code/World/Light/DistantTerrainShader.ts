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
            vec3 lightDir = -lightDirection;
            float ndotl = max(0.0, dot(vNormal, lightDir));
            
            vec3 skyColor = vec3(0.8, 0.8, 0.8) * (sunLightIntensity + 0.2);
            vec3 finalColor = vColor * (ndotl * sunLightIntensity * 0.6 + skyColor * 0.6);
            
            float dist = length(vPositionW - cameraPosition);
            float fogFactor = clamp((vFogInfos.z - dist) / (vFogInfos.z - vFogInfos.y), 0.0, 1.0);
            
            // Atmospheric perspective: Blue hue gradient based on height
            // Lighter at the bottom, darker at the peaks
            // Adjusted to start gradient from -20 to cover valleys/ocean floor
            float heightFactor = clamp((vPositionW.y) / 300.0, 0.0, 1.0);
            vec3 deepBlue = vec3(0.1, 0.2, 0.4);
            vec3 lightBlue = vec3(0.6, 0.75, 0.95);
            
            vec3 atmosphereColor = mix(lightBlue, deepBlue, heightFactor) * (sunLightIntensity * sunLightIntensity);
            vec3 effectiveFogColor = mix(vFogColor, atmosphereColor, 0.8);
            
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
            vec3 lightDir = normalize(-lightDirection);
            vec3 normal = vec3(0.0, 1.0, 0.0);
            
            vec3 viewDir = normalize(cameraPosition - vPositionW);
            vec3 reflectDir = reflect(-lightDir, normal);
            float spec = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);
            vec3 specular = vec3(1.0) * spec * sunLightIntensity;
            
            vec3 waterColor = vec3(0.0, 0.1, 0.3);
            vec3 finalColor = waterColor * (sunLightIntensity * 0.8 + 0.1   ) + specular;

            float dist = length(vPositionW - cameraPosition);
            float fogFactor = clamp((vFogInfos.z - dist) / (vFogInfos.z - vFogInfos.y), 0.0, 1.0);
            
            float heightFactor = clamp((vPositionW.y + 20.0) / 300.0, 0.0, 1.0);
            vec3 deepBlue = vec3(0.1, 0.2, 0.4);
            vec3 lightBlue = vec3(0.6, 0.75, 0.95);
            vec3 atmosphereColor = mix(lightBlue, deepBlue, heightFactor) * (sunLightIntensity * sunLightIntensity);
            vec3 effectiveFogColor = mix(vFogColor, atmosphereColor, 0.6);

            vec3 colorWithFog = mix(effectiveFogColor, finalColor, fogFactor);

            gl_FragColor = vec4(colorWithFog, 1.0);
        }
    `;
}
