import * as BABYLON from "@babylonjs/core";
import type { Player } from "../Player/Player";

export class UnderWaterEffect {
	public material: BABYLON.ShaderMaterial;
	public postProcess: BABYLON.PostProcess;

	private scene: BABYLON.Scene;
	private camera: BABYLON.Camera;
	private player: Player;
	private depthRenderer: BABYLON.DepthRenderer;
	private time = 0;
	private rate = 0.01;

	private static readonly VERTEX_SHADER: string = `
        precision lowp float;

        attribute vec3 position;
        attribute vec2 uv;
        attribute vec3 normal;

        uniform mat4 world;
        uniform mat4 view;
        uniform mat4 worldViewProjection;
        uniform float time;

        varying vec2 vUV;
        varying vec3 vNormal;
        varying vec3 vPosition;

        #ifndef NUM_BONE_INFLUENCERS
        #define NUM_BONE_INFLUENCERS 4
        #define BonesPerMesh 60
        #endif

        #if NUM_BONE_INFLUENCERS > 0
            uniform mat4 mBones[BonesPerMesh];
            attribute vec4 matricesIndices;
            attribute vec4 matricesWeights;
            #if NUM_BONE_INFLUENCERS > 4
                attribute vec4 matricesIndicesExtra;
                attribute vec4 matricesWeightsExtra;
            #endif
        #endif

        void main(void) {
            vec4 p = vec4(position, 1.0);

            #if NUM_BONE_INFLUENCERS > 0
                mat4 influence = mBones[int(matricesIndices[0])] * matricesWeights[0];
                #if NUM_BONE_INFLUENCERS > 1
                    influence += mBones[int(matricesIndices[1])] * matricesWeights[1];
                #endif
                #if NUM_BONE_INFLUENCERS > 2
                    influence += mBones[int(matricesIndices[2])] * matricesWeights[2];
                #endif
                #if NUM_BONE_INFLUENCERS > 3
                    influence += mBones[int(matricesIndices[3])] * matricesWeights[3];
                #endif
                #if NUM_BONE_INFLUENCERS > 4
                    influence += mBones[int(matricesIndicesExtra[0])] * matricesWeightsExtra[0];
                #endif
                #if NUM_BONE_INFLUENCERS > 5
                    influence += mBones[int(matricesIndicesExtra[1])] * matricesWeightsExtra[1];
                #endif
                #if NUM_BONE_INFLUENCERS > 6
                    influence += mBones[int(matricesIndicesExtra[2])] * matricesWeightsExtra[2];
                #endif
                #if NUM_BONE_INFLUENCERS > 7
                    influence += mBones[int(matricesIndicesExtra[3])] * matricesWeightsExtra[3];
                #endif
                p = influence * p;
            #endif

            vec4 worldPos = world * p;

            gl_Position = worldViewProjection * p;
            vUV = uv;
            vNormal = normal;
            vPosition = worldPos.xyz;
        }`;

	private static readonly FRAGMENT_SHADER: string = `
        precision lowp float;

        varying vec2 vUV;
        varying vec3 vNormal;
        varying vec3 vPosition;

        uniform float time;
        uniform mat4 world;
        uniform vec3 cameraPosition;
        uniform vec3 playerPosition;


        uniform sampler2D baseTexture;

        // Babylon.js fog uniforms
        uniform vec4 vFogInfos; 
        uniform vec3 vFogColor;

        #define TAU 6.28318530718
        #define MAX_ITER 4
        #define MIN_ITER 1.0

        float CalcFogFactor(float fFogDistance) {
            //float fogStart = vFogInfos.y;
            float fogEnd = vFogInfos.z;
            //float fogCoeff = (fogEnd - fFogDistance) / (fogEnd - vFogInfos.y);
            return clamp((fogEnd - fFogDistance) / (fogEnd - vFogInfos.y), 0.0, 1.0);
        }

        vec3 caustic(vec2 uv, float iterations) {
            vec2 p = mod(uv * TAU, TAU) - 250.0;
            float timeOffset = time * 0.5 + 23.0;
            vec2 i = vec2(p);
            float causticValue = 1.0;
            float intensityFactor = 0.006;

            for (float n = 1.0; n < (iterations + 0.9); n+= 1.0) {
                float t = timeOffset * (1.0 - (3.5 / float(n)));
                i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
                
                // FIX: Added a small epsilon (0.001) to the denominator to prevent division by zero
                float denominator_x = 0.0001 + abs(sin(i.x + t) / intensityFactor);
                float denominator_y = 0.0001 + abs(cos(i.y + t) / intensityFactor);

                causticValue += 1.0 / length(vec2(p.x / denominator_x, p.y / denominator_y));
            }

            causticValue /= iterations;
            causticValue = 1.17 - pow(causticValue, 1.4);
            vec3 color = vec3(pow(abs(causticValue), 8.0));
            color = clamp(color + vec3(0.0, 0.1, 0.3), 0.0, 1.0);
            //color = mix(color, vec3(1.0, 1.0, 1.0), 0.1);

            return color;
        }

        void main(void) {
            vec3 lightPosition = vec3(playerPosition.x, 10.0, playerPosition.z);
            
            vec3 textureColor = texture2D(baseTexture, vUV * 128.0 ).rgb;
 
            vec3 worldPosition = vPosition;
            vec2 causticUV = worldPosition.xz / 16.0;

               // --- LOD CALCULATION ---
                float distanceToCamera = length(vPosition - playerPosition);

                // Define a range for the transition, e.g., from 15 to 50 units
                float lodStartDistance = 20.0;
                float lodEndDistance = 100.0;

                // smoothstep creates a nice falloff from 1.0 (close) to 0.0 (far)
                float lodFactor = 1.0 - smoothstep(lodStartDistance, lodEndDistance, distanceToCamera);

                // Determine iterations based on distance.
                // MAX_ITER is the original max value (4).
                // Close up, we'll use 4 iterations. Far away, only 2.
                // We use max(2, ...) to ensure we don't have 0 or 1 iterations, which can look bad.
                float iterations = mix(MIN_ITER, float(MAX_ITER), lodFactor);


            vec3 worldNormal = normalize(vec3(world * vec4(vNormal, 0.0)));
            vec3 lightDirection = normalize(lightPosition - worldPosition);

            vec3 color = textureColor;
            float diffuseFactor = max(0.0, dot(worldNormal, lightDirection));

            color = (textureColor * diffuseFactor) + (caustic(causticUV, iterations) * diffuseFactor) ;
            
            // Apply fog
            float fFogDistance = length(worldPosition - cameraPosition);
            float fog = CalcFogFactor(fFogDistance);
            color = mix(vFogColor, color, fog);

            gl_FragColor = vec4(color, 0.0);
        }`;

	private static readonly BACKGROUND_POST_PROCESS_SHADER: string = `
        precision lowp float;

        varying vec2 vUV;

        uniform float time;
        uniform sampler2D textureSampler;
        uniform sampler2D dPass;
        uniform bool isUnderwater;
        uniform vec2 screenSize;

        #define TAU 6.28318530718
        #define MAX_ITERATIONS 4
        #define BASE_INTENSITY 0.008

        float causticPattern(float coordinate, float distortionPower, float globalTime)
        {
            float periodicCoordinate = mod(coordinate * TAU, TAU) - 250.0;
            float causticTime = globalTime * 0.5 + 23.0;

            float iteratorValue = periodicCoordinate;
            float causticIntensity = 0.0;
            
            for (int i = 0; i < MAX_ITERATIONS; i++) 
            {
                float timeOffset = causticTime * (1.0 - (3.5 / float(i + 1)));
                iteratorValue = periodicCoordinate + cos(timeOffset - iteratorValue) + sin(timeOffset + iteratorValue);
                
                // FIX: Added a small epsilon (0.001) to prevent division by zero
                float denominator = max(0.001, abs(sin(iteratorValue + timeOffset) / BASE_INTENSITY));
                causticIntensity += 1.0 / length(periodicCoordinate / denominator);
            }

            causticIntensity /= float(MAX_ITERATIONS);
            causticIntensity = 1.17 - pow(causticIntensity, distortionPower);
            
            return causticIntensity;
        }

        float getGodRays(vec2 screenUV)
        {
            float godRayIntensity = 0.0;
            godRayIntensity += pow(causticPattern((screenUV.x + 0.08 * screenUV.y) / 1.7 + 0.5, 1.8, time * 0.65), 10.0) * 0.05;
            godRayIntensity -= pow((1.0 - screenUV.y) * 0.3, 2.0) * 0.2;
            godRayIntensity += pow(causticPattern(sin(screenUV.x), 0.3, time * 0.7), 9.0) * 0.4; 
            godRayIntensity += pow(causticPattern(cos(screenUV.x * 2.3), 0.3, time * 1.3), 4.0) * 0.1;
            godRayIntensity -= pow((1.0 - screenUV.y) * 0.3, 3.0);
            return clamp(godRayIntensity, 0.0, 2.0);
        }

        float hash(float seed)
        {
            return fract(sin(seed) * 43758.5453123);
        }

        float renderBubble(vec2 pixelLocation, vec2 bubbleCenter, float bubbleRadius)
        {
            vec2 vectorToCenter = pixelLocation - bubbleCenter;
            float distanceFactor = dot(vectorToCenter, vectorToCenter) / bubbleRadius;

            if (distanceFactor > 1.0) return pow(max(0.0, 1.5 - distanceFactor), 3.0) * 5.0;

            distanceFactor = pow(distanceFactor, 6.0);
            
            vec2 highlightVectorTop = pixelLocation - bubbleCenter + vec2(-bubbleRadius * 7.0, +bubbleRadius * 7.0);
            distanceFactor += 0.8 / max(sqrt((dot(highlightVectorTop, highlightVectorTop)) / bubbleRadius * 8.0), 0.3);
            
            vec2 highlightVectorBack = pixelLocation - bubbleCenter + vec2(+bubbleRadius * 7.0, -bubbleRadius * 7.0);
            distanceFactor += 0.2 / max((dot(highlightVectorBack, highlightVectorBack) / bubbleRadius * 4.0), 0.3);

            return distanceFactor;
        }
            
        void main(void) {

            vec3 finalColor = texture2D(textureSampler, vUV).rgb;

            if(isUnderwater){

            vec3 skyColor = vec3(0.3, 1.0, 1.0);
            vec2 aspectCorrectedUV = vUV * vec2(screenSize.x / screenSize.y, 1.0);
            
            float depthValue = texture2D(dPass, vUV).r;
            // Use a smoother falloff for depth instead of a hard cutoff
            depthValue = smoothstep(0.9, 1.0, depthValue);

          
            for (float bubbleIndex = 0.0; bubbleIndex < 6.0; bubbleIndex += 1.0)
            {
                float bubbleTime = time * 0.5 + 5.27;
                float animationFrame = floor((bubbleTime + 2.0) / 4.0);
                vec2 bubblePosition = vec2(0.4, -0.9) + vec2(0.0, mod(bubbleTime + (bubbleIndex / 50.0) + hash(bubbleIndex + animationFrame) * 0.7, 4.0));
                bubblePosition.x += hash(bubbleIndex) * (aspectCorrectedUV.y + 0.6);
                
                float bubbleRadius = 0.002 * hash(bubbleIndex - animationFrame);
                float bubbleIntensity = renderBubble(bubblePosition, aspectCorrectedUV, bubbleRadius);
                bubbleIntensity *= hash(bubbleIndex + animationFrame + 399.0) * 0.3;
                
                vec3 bubbleColor = vec3(0.6 + hash(animationFrame * 323.1 + bubbleIndex) * 0.4, 1.0, 1.0);
                finalColor = mix(finalColor, bubbleColor, bubbleIntensity);
            }

            vec3 godRayColorLayer1 = getGodRays(aspectCorrectedUV * 0.5) * mix(skyColor, vec3(1.0), aspectCorrectedUV.y * aspectCorrectedUV.y) * vec3(0.7, 1.0, 1.0);
            vec3 godRayColorLayer2 = getGodRays(aspectCorrectedUV * 2.0) * mix(skyColor, vec3(1.0), aspectCorrectedUV.y * aspectCorrectedUV.y) * vec3(0.7, 1.0, 1.0);
            vec3 godRayColor = (godRayColorLayer1 * depthValue) + godRayColorLayer2;

            finalColor += godRayColor * (1.0 - vUV.y);
            }
            gl_FragColor = vec4(finalColor, 1.0);
        }`;

	constructor(
		scene: BABYLON.Scene,
		camera: BABYLON.Camera,
		player: Player,
		baseTexture: BABYLON.Texture,
	) {
		// NEW: Added baseTexture parameter
		this.scene = scene;
		this.camera = camera;
		this.player = player;

		this.registerShaders();

		this.material = this.createShaderMaterial(baseTexture); // NEW: Pass baseTexture
		// Enable depth renderer and ensure it generates a linear depth map
		this.depthRenderer = this.scene.enableDepthRenderer(camera);
		this.depthRenderer.useOnlyInActiveCamera = true;

		this.postProcess = this.createPostProcess();

		this.scene.registerBeforeRender(this.update);
	}

	private registerShaders(): void {
		BABYLON.Effect.ShadersStore["underWaterVertexShader"] =
			UnderWaterEffect.VERTEX_SHADER;
		BABYLON.Effect.ShadersStore["underWaterFragmentShader"] =
			UnderWaterEffect.FRAGMENT_SHADER;
		BABYLON.Effect.ShadersStore["underWaterBackGroundFragmentShader"] =
			UnderWaterEffect.BACKGROUND_POST_PROCESS_SHADER;
	}

	private createShaderMaterial(
		baseTexture: BABYLON.Texture,
	): BABYLON.ShaderMaterial {
		const material = new BABYLON.ShaderMaterial(
			"underWaterShader",
			this.scene,
			{
				vertex: "underWater",
				fragment: "underWater",
			},
			{
				attributes: [
					"position",
					"normal",
					"uv",
					"matricesIndices",
					"matricesWeights",
				],
				samplers: ["baseTexture"], // NEW: Declare baseTexture as a sampler
				uniforms: [
					"world",
					"worldViewProjection",
					"time",
					"cameraPosition",
					"playerPosition",
					"isUnderwater",
					"vFogInfos",
					"vFogColor",
					"mBones",
				],
			},
		);
		material.setTexture("baseTexture", baseTexture); // NEW: Set the texture uniform
		return material;
	}

	private createPostProcess(): BABYLON.PostProcess {
		const postProcess = new BABYLON.PostProcess(
			"UnderWaterBackground",
			"underWaterBackGround",
			["time", "screenSize", "playerPosition", "isUnderwater"],
			["dPass"],
			1.0,
			this.camera,
		);

		postProcess.onApply = (effect: BABYLON.Effect) => {
			effect.setFloat2("screenSize", postProcess.width, postProcess.height);
			effect.setFloat("time", this.time);
			effect.setVector3("playerPosition", this.player.position);
			effect.setBool("isUnderwater", this.player.position.y < 1.8);
			effect.setTexture("dPass", this.depthRenderer.getDepthMap());
		};

		return postProcess;
	}

	private update = (): void => {
		this.time +=
			(this.scene.getEngine().getDeltaTime() / 1000) * this.rate * 100;

		this.material.setFloat("time", this.time);
		if (this.scene.activeCamera) {
			this.material.setVector3(
				"cameraPosition",
				this.scene.activeCamera.position,
			);
			this.material.setVector3("playerPosition", this.player.position);
		}
	};

	public dispose(): void {
		this.scene.unregisterBeforeRender(this.update);
		this.material.dispose();
		this.postProcess.dispose();
	}
}
