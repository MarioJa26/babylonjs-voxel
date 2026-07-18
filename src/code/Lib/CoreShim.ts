/**
 * CoreShim — drop-in replacement for `@babylonjs/core` used by the Lite port.
 *
 * The project no longer depends on the real `@babylonjs/core` package: both
 * tsconfig `paths` and the Vite resolver map `@babylonjs/core` (and its
 * subpaths) to this file. It:
 *   1. re-exports the pure-TS math from `./Math` under the familiar names, and
 *   2. aliases Babylon *Lite* types to their old core names (Scene -> SceneContext,
 *      Mesh -> Mesh, Texture -> Texture2D, lights, cameras, ...), and
 *   3. provides permissive (`any`) stubs for core-only APIs that the gameplay
 *      files still reference. Those stubs are temporary scaffolding: each gameplay
 *      file is ported individually to use the real Lite API and drop the stub.
 */

/* ---- Lite type aliases (core name -> Lite) ---- */
export type {
	Mesh,
	Mesh as AbstractMesh,
	ParticleSystem,
	PickingInfo,
	PointLight,
	ShaderMaterial,
	SpotLight,
	Texture2D as Texture,
} from "@babylonjs/lite";
export * from "./Math";

/* ---- permissive stubs for core-only APIs (replaced during per-file port) ---- */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const MeshBuilder: any = {};
export const SceneLoader: any = {};

export const StandardMaterial: any = class {};
export const ImportMeshAsync: any = async (..._a: any[]) => ({});

export const Effect: any = {
	ShadersStore: {} as Record<string, string>,
	RegisterShader: (..._a: any[]) => {},
	Shaders: {} as Record<string, string>,
};
