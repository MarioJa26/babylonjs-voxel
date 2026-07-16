// Empty stub for @babylonjs/loaders in the Lite port.
// The original game side-effect-imports "@babylonjs/loaders/glTF" (in the boat
// entities) to register the glTF loader plugin. The Babylon Lite build never
// uses glTF loading (boats are deferred and will be procedural), so we alias
// the package to this empty module to keep the bundle resolvable.
export {};
