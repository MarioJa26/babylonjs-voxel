export const SkyVertexShader = `
        #version 300 es
        precision highp float;

        // Attributes
        in vec3 position;

        // Uniforms
        uniform mat4 worldViewProjection;

        // Varyings
        out vec3 vPosition;

        void main(void) {
            gl_Position = worldViewProjection * vec4(position, 1.0);
            vPosition = position;
        }
    `;

export const SkyFragmentShader = `
        #version 300 es
        precision highp float;

        // Varyings
        in vec3 vPosition;

        // Uniforms
        uniform vec3 sunDirection;

        out vec4 fragColor;

        void main(void) {
            // 1. Calculate view direction
            vec3 viewDirection = normalize(vPosition);

            // 2. Create sky gradient
            float skyFactor = smoothstep(0.0, 0.4, viewDirection.y);
            vec3 skyColor = mix(vec3(0.5, 0.7, 0.9), vec3(0.1, 0.3, 0.6), skyFactor);

            // 3. Draw the sun
            // dot() of two unit vectors relates exactly to distance() via
            // distance^2 = 2 - 2*dot, so thresholds below are converted
            // 1:1 from the original distance-space values (0.015/0.01/0.1/0.0).
            // No sqrt needed, and the resulting curve is mathematically identical.
            float sunDot = dot(viewDirection, sunDirection);

            float sunDisc = smoothstep(0.9998875, 0.99995, sunDot);
            float sunGlow = smoothstep(0.995, 1.0, sunDot);

            vec3 finalColor = skyColor;
            finalColor += sunGlow * vec3(1.0, 0.9, 0.7) * 0.3; // Additive glow
            finalColor += sunDisc * vec3(1.0, 1.0, 0.9);      // Additive sun disc

            // Unclamped on purpose: overshoot past vec3(0.1,0.1,0.2) at deep
            // night gives the reddish-black tint.
            if (sunDirection.y < 0.0) {
                finalColor = mix(finalColor, vec3(0.1, 0.1, 0.2), -sunDirection.y * 2.0);
            }

            fragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
        }
    `;
