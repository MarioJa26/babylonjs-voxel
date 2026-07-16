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
	ArcRotateCamera,
	Camera,
	Camera as TargetCamera,
	DirectionalLight,
	EngineContext as Engine,
	FreeCamera,
	HemisphericLight,
	Material,
	Mesh,
	Mesh as AbstractMesh,
	ParticleSystem,
	PickingInfo,
	PointLight,
	SceneContext as Scene,
	SceneContext,
	SceneNode as TransformNode,
	ShaderMaterial,
	SpotLight,
	Texture2D as Texture,
} from "@babylonjs/lite";
export * from "./Math";

/* ---- permissive stubs for core-only APIs (replaced during per-file port) ---- */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const MeshBuilder: any = {};
export const RawTexture: any = {};
export const SceneLoader: any = {};
export const Logger: any = {
	Log: (..._a: any[]) => {},
	Warn: (..._a: any[]) => {},
	Error: (..._a: any[]) => {},
};
export const StandardMaterial: any = class {};
export const DynamicTexture: any = class {};
export const RenderTargetTexture: any = class {};
export const GlowLayer: any = class {};
export const HighlightLayer: any = class {};
export const AssetsManager: any = class {};
export const CSG: any = class {};
export const VertexBuffer: any = class {};
export const VertexData: any = class {};
export const BoundingInfo: any = class {};
export const BoundingBox: any = class {};
export const Plane: any = class {};
export const Ray: any = class {};
export const Observer: any = class {};
export const Animation: any = class {};
export const Animatable: any = class {};
export const Vector4: any = class {};
export const ImportMeshAsync: any = async (..._a: any[]) => ({});
export const Trajectory: any = class {};
export const PhotoDome: any = class {};
export const PointsCloudSystem: any = class {};
export const VolumetricLightScatteringPostProcess: any = class {};
export const LensFlareSystem: any = class {};
export const SSAO2Configuration: any = class {};
export const Geometry: any = class {};
export const TransformNodeConstructor: any = class {};
export const MirrorMaterial: any = class {};
export const PBRMaterial: any = class {};
export const CubeTexture: any = class {};
export const HDRCubeTexture: any = class {};
export const ReflectionProbe: any = class {};
export const ShadowGenerator: any = class {};
export const DepthRenderer: any = class {};
export const Effect: any = {
	ShadersStore: {} as Record<string, string>,
	RegisterShader: (..._a: any[]) => {},
	Shaders: {} as Record<string, string>,
};
export const PostProcess: any = class {};
export const ImageProcessingConfiguration: any = class {};
export const ColorCorrectionPostProcess: any = class {};
export const FXAAPostProcess: any = class {};
export const DefaultRenderingPipeline: any = class {};
export const SSAORenderingPipeline: any = class {};
export const OutlineRenderer: any = class {};
export const EdgesRenderer: any = class {};
export const LinesMesh: any = class {};
export const TrailMesh: any = class {};
export const RibbonBuilder: any = class {};
export const PolygonMeshBuilder: any = class {};
export const Decal: any = class {};
export const FlowMaterial: any = class {};
export const GridMaterial: any = class {};
export const SkyMaterial: any = class {};
export const WaterMaterial: any = class {};
export const FurMaterial: any = class {};
export const LavaMaterial: any = class {};
export const GradientMaterial: any = class {};
export const TriPlanarMaterial: any = class {};
export const TerrainMaterial: any = class {};
export const FireMaterial: any = class {};
export const CellMaterial: any = class {};
export const SimpleMaterial: any = class {};
export const MixMaterial: any = class {};
export const BumpMaterial: any = class {};
export const ShadowOnlyMaterial: any = class {};
export const NormalMaterial: any = class {};
export const CustomMaterial: any = class {};

/* physics (Havok) shims — replaced when gameplay is ported */
export const PhysicsAggregate: any = class {};
export const PhysicsShapeType: any = {
	BOX: 1,
	SPHERE: 2,
	CAPSULE: 3,
	MESH: 4,
	CONTAINER: 5,
	HEIGHTFIELD: 6,
};
export const PhysicsMotionType: any = {
	STATIC: 0,
	DYNAMIC: 1,
	ANIMATED: 2,
	DISABLED: 3,
};
export const PhysicsPrestepType: any = { NONE: 0, ON: 1 };
export const PhysicsConstraintAxis: any = {};
export const Physics6DoFConstraint: any = class {};
export const PhysicsBody: any = class {};
export const PhysicsShape: any = class {};
export const PhysicsViewer: any = class {};
export const HavokPlugin: any = class {};

/* ---- names that core's `Loading/sceneLoader` re-exported ---- */
export const PointerEventTypes: any = {
	PICK: 0,
	POINTERDOWN: 1,
	POINTERUP: 2,
	POINTERMOVE: 3,
	POINTERWHEEL: 4,
	POINTERPICK: 5,
	POINTERTAP: 6,
	POINTERDOUBLETAP: 7,
};
export const PointerInfo: any = class {};
export const Frustum: any = class {};
export const Light: any = class {};
export const LightGizmo: any = class {};
export const GizmoManager: any = class {};
export const SimplificationType: any = { QUADRATIC: 0 };
export const PointerDragBehavior: any = class {};
export const PointerEventTypesAlias = PointerEventTypes;

/* ---- glTF loader stubs (pulled in by @babylonjs/loaders side-effect import
   in boat entities; the Lite build never actually invokes glTF parsing) ---- */
export const AssetContainer: any = class {};
export const DataReader: any = class {};
export const DecodeBase64UrlToBinary: any = (): Uint8Array => new Uint8Array(0);
export const RegisterSceneLoaderPlugin: any = (): void => {};
export const RuntimeError: any = class extends Error {};
