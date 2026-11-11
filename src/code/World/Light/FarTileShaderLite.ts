import {
	createShaderMaterial,
	type EngineContext,
	type SceneContext,
	type ShaderMaterial,
	type StorageBuffer,
	setShaderStorageBuffer,
	setShaderTexture,
	setShaderUniform,
	type Texture2D,
} from "@babylonjs/lite";

const FOG_HELPER_WGSL = /* wgsl */ `
fn ftAtmosphereColor(heightFactor : f32) -> vec3<f32> {
  return mix(vec3<f32>(0.6, 0.75, 0.95), vec3<f32>(0.1, 0.2, 0.4), heightFactor)
    * (shaderUniforms.sunLightIntensity * shaderUniforms.sunLightIntensity);
}
fn ftSkyboxColor(viewDirY : f32, nightAmount : f32) -> vec3<f32> {
  let skyFactor = smoothstep(0.0, 0.4, max(viewDirY, 0.0));
  var skyboxColor = mix(vec3<f32>(0.5, 0.7, 0.9), vec3<f32>(0.1, 0.3, 0.6), skyFactor);
  skyboxColor = mix(skyboxColor, vec3<f32>(0.0), nightAmount);
  return skyboxColor;
}`;

// Face-independent data only. Corner weights are computed after frustum culling.
const FACE_EXPAND_WGSL = /* wgsl */ `
const FAR_TILE_Y_OFFSET : f32 = 1024.0;
struct TerrainFace {
  x:f32, y:f32, z:f32, w:f32, h:f32,
  tileX:f32, tileY:f32, lightFactor:f32, axis:u32,
}
struct WaterFace { x:f32, y:f32, z:f32, w:f32, h:f32, }
fn decodeCornerWeights(vi:u32) -> vec2<f32> {
  let corner = vi & 3u;
  return vec2<f32>(f32(((corner >> 1u) ^ corner) & 1u), f32((corner >> 1u) & 1u));
}
fn expandFace(faceIndex:u32) -> TerrainFace {
  var d:TerrainFace;
  let i4=faceIndex<<2u;
  let w0=faceData[i4]; let w1=faceData[i4+1u];
  let w2=faceData[i4+2u]; let w3=faceData[i4+3u];
  let origin=tileOrigins[(w3>>8u)&0xffffu];
  d.x=origin.x+f32(w0&0x3ffu);
  d.y=f32((w0>>10u)&0xfffu)-FAR_TILE_Y_OFFSET;
  d.z=origin.y+f32((w0>>22u)&0x3ffu);
  d.w=f32(w1&0x3ffu); d.h=f32((w1>>10u)&0x3ffu);
  d.axis=(w1>>21u)&3u;
  d.tileX=f32(w2&0xffu); d.tileY=f32((w2>>8u)&0xffu);
  d.lightFactor=select(0.8,1.0,((w2>>16u)&0xffu)>=224u);
  return d;
}
fn expandWaterFace(faceIndex:u32) -> WaterFace {
  var d:WaterFace;
  let i4=faceIndex<<2u;
  let w0=faceData[i4]; let w1=faceData[i4+1u]; let w3=faceData[i4+3u];
  let origin=tileOrigins[(w3>>8u)&0xffffu];
  d.x=origin.x+f32(w0&0x3ffu);
  d.y=f32((w0>>10u)&0xfffu)-FAR_TILE_Y_OFFSET;
  d.z=origin.y+f32((w0>>22u)&0x3ffu);
  d.w=f32(w1&0x3ffu); d.h=f32((w1>>10u)&0x3ffu);
  return d;
}
struct AxisBasis { u:vec3<f32>, v:vec3<f32>, n:vec3<f32>, }
fn axisBases(axis:u32) -> AxisBasis {
  let isX=select(0.0,1.0,axis==0u); let isY=select(0.0,1.0,axis==1u);
  let isZ=1.0-max(isX,isY); var b:AxisBasis;
  b.u=vec3<f32>(isZ,isX,isY); b.v=vec3<f32>(isY,isZ,isX); b.n=vec3<f32>(isX,isY,isZ);
  return b;
}`;

const FRUSTUM_CULL_WGSL = /* wgsl */ `
fn ftFrustumCulled(center:vec3<f32>,radius:f32)->bool {
  let fp0=frustumPlanes[0]; if(dot(fp0.xyz,center)+fp0.w < -radius){return true;}
  let fp1=frustumPlanes[1]; if(dot(fp1.xyz,center)+fp1.w < -radius){return true;}
  let fp2=frustumPlanes[2]; if(dot(fp2.xyz,center)+fp2.w < -radius){return true;}
  let fp3=frustumPlanes[3]; if(dot(fp3.xyz,center)+fp3.w < -radius){return true;}
  let fp4=frustumPlanes[4]; if(dot(fp4.xyz,center)+fp4.w < -radius){return true;}
  let fp5=frustumPlanes[5]; if(dot(fp5.xyz,center)+fp5.w < -radius){return true;}
  return false;
}`;

const terrainVertexWGSL = /* wgsl */ `
${FACE_EXPAND_WGSL}
${FOG_HELPER_WGSL}
${FRUSTUM_CULL_WGSL}
struct VSOut {
 @builtin(position) pos:vec4<f32>, @location(0) vUV:vec2<f32>,
 @location(1) vTileShade:vec3<f32>, @location(2) vFogColor:vec3<f32>,
 @location(3) vFogFactor:f32,
};
@vertex fn mainVertex(input:VertexInput,@builtin(vertex_index) vertexIndex:u32)->VSOut {
 var out:VSOut;
 let face=expandFace(u32(input.instData.x));
 let bases=axisBases(face.axis);
 let halfWidth=face.w*0.5; let halfHeight=face.h*0.5;
 let faceCenter=vec3<f32>(face.x,face.y,face.z)+bases.u*halfWidth+bases.v*halfHeight;
 let faceRadius=sqrt(halfWidth*halfWidth+halfHeight*halfHeight)+2.0;
 if(ftFrustumCulled(faceCenter,faceRadius)){
  out.pos=vec4<f32>(2.0,2.0,2.0,1.0); out.vUV=vec2<f32>(0.0);
  out.vTileShade=vec3<f32>(0.0); out.vFogColor=vec3<f32>(0.0); out.vFogFactor=0.0; return out;
 }
 let corner=decodeCornerWeights(vertexIndex);
 let worldPos=vec3<f32>(face.x,face.y,face.z)+bases.u*(corner.x*face.w)+bases.v*(corner.y*face.h);
 out.pos=shaderSystem.worldViewProjection*vec4<f32>(worldPos,1.0);
 let isXFace=face.axis==0u; let isYFace=face.axis==1u;
 out.vUV=vec2<f32>(select(worldPos.x,worldPos.z,isXFace),select(worldPos.y,worldPos.z,isYFace))/shaderUniforms.textureScale;
 let sun=shaderUniforms.sunLightIntensity;
 let ndotl=max(0.0,dot(bases.n,shaderUniforms.lightDirection));
 let shade=(ndotl*sun*0.6+0.48*(sun+0.2))*mix(0.55,1.0,face.lightFactor);
 out.vTileShade=vec3<f32>(face.tileX,face.tileY,shade);
 let toCamera=shaderSystem.cameraPosition-worldPos;
 let distanceSquared=dot(toCamera,toCamera);
 let distance=sqrt(distanceSquared);
 out.vFogFactor=clamp((shaderUniforms.fogInfos.z-distance)*shaderUniforms.fogInvRange,0.0,1.0);
 let heightFactor=clamp(worldPos.y*0.003,0.0,1.0);
 let atmosphereColor=ftAtmosphereColor(heightFactor);
 let nightAmount=clamp(1.0-sun,0.0,1.0);
 var baseFogColor=mix(shaderUniforms.fogColor,atmosphereColor,0.8);
 baseFogColor=mix(baseFogColor,vec3<f32>(0.0),nightAmount);
 let inverseDistance=inverseSqrt(max(distanceSquared,1e-8));
 let viewDirY=toCamera.y*inverseDistance;
 let skyboxColor=ftSkyboxColor(viewDirY,nightAmount);
 let skyBlend=clamp((distance-1400.0)*0.0003333,0.0,1.0);
 out.vFogColor=mix(baseFogColor,skyboxColor,skyBlend);
 return out;
}`;

const terrainFragmentWGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos:vec4<f32>, @location(0) vUV:vec2<f32>, @location(1) vTileShade:vec3<f32>, @location(2) vFogColor:vec3<f32>, @location(3) vFogFactor:f32, };
fn sampleAtlasTile(tile:vec2<f32>,worldUV:vec2<f32>)->vec3<f32>{
 let tileSize=shaderUniforms.atlasTileSize;
 let baseUV=vec2<f32>(tile.x*tileSize,1.0-((tile.y+1.0)*tileSize));
 let atlasUV=baseUV+fract(worldUV)*tileSize;
 return textureSampleLevel(diffuseTexture,diffuseTextureSampler,atlasUV,0.0).rgb;
}
@fragment fn mainFragment(in:VSOut)->@location(0) vec4<f32>{
 if(in.vFogFactor<=0.02){return vec4<f32>(in.vFogColor,1.0);}
 let texColor=sampleAtlasTile(in.vTileShade.xy,in.vUV);
 let finalColor=texColor*in.vTileShade.z;
 return vec4<f32>(mix(in.vFogColor,finalColor,in.vFogFactor),1.0);
}`;

const waterVertexWGSL = /* wgsl */ `
${FACE_EXPAND_WGSL}
${FOG_HELPER_WGSL}
${FRUSTUM_CULL_WGSL}
struct VSOut { @builtin(position) pos:vec4<f32>, @location(0) vPositionW:vec3<f32>, @location(1) vFogColor:vec3<f32>, @location(2) vFogFactor:f32, };
@vertex fn mainVertex(input:VertexInput,@builtin(vertex_index) vertexIndex:u32)->VSOut{
 var out:VSOut;
 let face=expandWaterFace(u32(input.instData.x));
 let halfX=face.h*0.5; let halfZ=face.w*0.5;
 let faceCenter=vec3<f32>(face.x+halfX,face.y,face.z+halfZ);
 let faceRadius=sqrt(halfX*halfX+halfZ*halfZ)+2.0;
 if(ftFrustumCulled(faceCenter,faceRadius)){
  out.pos=vec4<f32>(2.0,2.0,2.0,1.0); out.vPositionW=faceCenter;
  out.vFogColor=vec3<f32>(0.0); out.vFogFactor=0.0; return out;
 }
 let corner=decodeCornerWeights(vertexIndex);
 let worldPos=vec3<f32>(face.x+corner.y*face.h,face.y,face.z+corner.x*face.w);
 out.pos=shaderSystem.worldViewProjection*vec4<f32>(worldPos,1.0);
 out.vPositionW=worldPos;
 let toCamera=shaderSystem.cameraPosition-worldPos;
 let distanceSquared=dot(toCamera,toCamera);
 let distance=sqrt(distanceSquared);
 out.vFogFactor=clamp((shaderUniforms.fogInfos.z-distance)*shaderUniforms.fogInvRange,0.0,1.0);
 let heightFactor=clamp(worldPos.y*0.003,0.0,1.0);
 let atmosphereColor=ftAtmosphereColor(heightFactor);
 let sun=shaderUniforms.sunLightIntensity;
 let nightAmount=clamp(1.0-sun,0.0,1.0);
 var baseFogColor=mix(shaderUniforms.fogColor,atmosphereColor,0.8);
 baseFogColor=mix(baseFogColor,vec3<f32>(0.0),nightAmount);
 let inverseDistance=inverseSqrt(max(distanceSquared,1e-8));
 let viewDirY=toCamera.y*inverseDistance;
 let skyboxColor=ftSkyboxColor(viewDirY,nightAmount);
 let skyBlend=clamp((distance-7000.0)*0.0003333,0.0,1.0);
 out.vFogColor=mix(baseFogColor,skyboxColor,skyBlend);
 return out;
}`;

const waterFragmentWGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos:vec4<f32>, @location(0) vPositionW:vec3<f32>, @location(1) vFogColor:vec3<f32>, @location(2) vFogFactor:f32, };
@fragment fn mainFragment(in:VSOut)->@location(0) vec4<f32>{
 if(in.vFogFactor<=0.02){return vec4<f32>(in.vFogColor,1.0);}
 const normal=vec3<f32>(0.0,1.0,0.0);
 let viewDelta=shaderSystem.cameraPosition-in.vPositionW;
 let inverseViewLength=inverseSqrt(max(dot(viewDelta,viewDelta),1e-8));
 let viewDir=viewDelta*inverseViewLength;
 let reflectDir=reflect(shaderUniforms.lightDirection,normal);
 let reflectionAmount=max(dot(viewDir,reflectDir),0.0);
 let specularFactor=exp2(clamp(92.3328*(reflectionAmount-1.0),-126.0,0.0));
 let sun=shaderUniforms.sunLightIntensity;
 let litWater=vec3<f32>(0.0,0.25,0.55)*(sun*0.8+0.2);
 let nightWater=vec3<f32>(0.0,0.06,0.18);
 let finalColor=mix(nightWater,litWater,sun)+vec3<f32>(specularFactor*sun);
 return vec4<f32>(mix(in.vFogColor,finalColor,in.vFogFactor),1.0);
}`;

export interface FarTileMaterialOptions {
	engine: EngineContext;
	scene: SceneContext;
	diffuseTexture: Texture2D | null;
	atlasTileSize: number;
	textureScale: number;
	nameSuffix?: string;
}
function applyCommonUniformDefaults(material: ShaderMaterial): void {
	setShaderUniform(material, "sunLightIntensity", 1);
	setShaderUniform(material, "lightDirection", [0, 1, 0]);
	setShaderUniform(material, "fogInfos", [0, 0, 1000, 0]);
	setShaderUniform(material, "fogColor", [0.6, 0.7, 0.9]);
	setShaderUniform(material, "fogInvRange", 1 / 1000);
}
export function bindFarTileBuffers(
	material: ShaderMaterial,
	faceBuffer: StorageBuffer,
	originsBuffer: StorageBuffer,
	frustumPlanesBuffer?: StorageBuffer | null,
): void {
	setShaderStorageBuffer(material, "faceData", faceBuffer);
	setShaderStorageBuffer(material, "tileOrigins", originsBuffer);
	if (frustumPlanesBuffer)
		setShaderStorageBuffer(material, "frustumPlanes", frustumPlanesBuffer);
}
export function createFarTileTerrainMaterial(
	opts: FarTileMaterialOptions,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: opts.nameSuffix
			? `farTileTerrainLite_${opts.nameSuffix}`
			: "farTileTerrainLite",
		vertexSource: terrainVertexWGSL,
		fragmentSource: terrainFragmentWGSL,
		attributes: ["position"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "atlasTileSize", type: "f32" },
			{ name: "textureScale", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
			{ name: "fogInvRange", type: "f32" },
		],
		storageBuffers: [
			{ name: "faceData", type: "array<u32>" },
			{ name: "tileOrigins", type: "array<vec2<f32>>" },
			{ name: "frustumPlanes", type: "array<vec4<f32>, 6>" },
		],
		samplers: ["diffuseTexture"],
		backFaceCulling: true,
	});
	setShaderTexture(material, "diffuseTexture", opts.diffuseTexture);
	setShaderUniform(material, "atlasTileSize", opts.atlasTileSize);
	setShaderUniform(material, "textureScale", opts.textureScale);
	applyCommonUniformDefaults(material);
	return material;
}
export function createFarTileWaterMaterial(
	nameSuffix?: string,
): ShaderMaterial {
	const material = createShaderMaterial({
		name: nameSuffix ? `farTileWaterLite_${nameSuffix}` : "farTileWaterLite",
		vertexSource: waterVertexWGSL,
		fragmentSource: waterFragmentWGSL,
		attributes: ["position"],
		uniforms: [
			"world",
			"worldViewProjection",
			"cameraPosition",
			{ name: "lightDirection", type: "vec3<f32>" },
			{ name: "sunLightIntensity", type: "f32" },
			{ name: "fogInfos", type: "vec4<f32>" },
			{ name: "fogColor", type: "vec3<f32>" },
			{ name: "fogInvRange", type: "f32" },
		],
		samplers: [],
		storageBuffers: [
			{ name: "faceData", type: "array<u32>" },
			{ name: "tileOrigins", type: "array<vec2<f32>>" },
			{ name: "frustumPlanes", type: "array<vec4<f32>, 6>" },
		],
		backFaceCulling: true,
		depthWrite: false,
	});
	applyCommonUniformDefaults(material);
	return material;
}
