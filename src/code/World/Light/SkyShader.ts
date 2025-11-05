export class SkyShader {
  static readonly skyVertexShader = `
        precision highp float;

        // Attributes
        attribute vec3 position;

        // Uniforms
        uniform mat4 worldViewProjection;

        // Varyings
        varying vec3 vPosition;

        void main(void) {
            gl_Position = worldViewProjection * vec4(position, 1.0);
            vPosition = position;
        }
    `;

  static readonly skyFragmentShader = `
        precision highp float;

        // Varyings
        varying vec3 vPosition;

        // Uniforms
        uniform vec3 sunDirection;

        void main(void) {
            // 1. Calculate view direction
            // For a skybox, the vector from the center to the vertex position is the view direction.
            vec3 viewDirection = normalize(vPosition);

            // 2. Create sky gradient
            // A simple gradient from a light blue at the horizon to a darker blue at the zenith.
            float skyFactor = smoothstep(0.0, 0.4, viewDirection.y);
            vec3 skyColor = mix(vec3(0.5, 0.7, 0.9), vec3(0.1, 0.3, 0.6), skyFactor);

            // 3. Draw the sun
            // Calculate distance between the view direction and the sun's direction.
            float sunDistance = distance(viewDirection, sunDirection);

            // Create a sharp sun disc
            float sunDisc = smoothstep(0.015, 0.01, sunDistance);

            // Create a softer glow around the sun
            float sunGlow = smoothstep(0.1, 0.0, sunDistance);

            // Combine colors
            // Start with the sky color.
            // Add the sun glow, tinted slightly yellow.
            // Add the sun disc, which is bright white.
            vec3 finalColor = skyColor;
            finalColor += sunGlow * vec3(1.0, 0.9, 0.7) * 0.5; // Additive glow
            finalColor += sunDisc * vec3(1.0, 1.0, 0.9);      // Additive sun disc

            // Ensure the sun is visible even when it's below the horizon by checking its y-direction
            if (sunDirection.y < 0.0) {
                finalColor = mix(finalColor, vec3(0.1, 0.1, 0.2), -sunDirection.y * 2.0);
            }

            gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
        }
    `;
}
