import { ComputeShader, StorageBuffer, Engine } from "@babylonjs/core";

export class VoxelComputeShader {
  private computeShader: ComputeShader;

  constructor(engine: Engine) {
    // WGSL Shader Code
    const computeSource = `
      struct VoxelData {
          blocks: array<u32>
      };

      @group(0) @binding(0) var<storage, read> inputBuffer : VoxelData;
      @group(0) @binding(1) var<storage, read_write> outputBuffer : VoxelData;

      @compute @workgroup_size(64, 1, 1)
      fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
          let index = global_id.x;
          
          // Ensure we don't go out of bounds
          if (index >= arrayLength(&inputBuffer.blocks)) {
              return;
          }

          let blockID = inputBuffer.blocks[index];

          // Example Logic: Pass through data (or modify it here)
          outputBuffer.blocks[index] = blockID;
      }
    `;

    this.computeShader = new ComputeShader(
      "voxelCompute",
      engine,
      { computeSource },
      {
        bindingsMapping: {
          inputBuffer: { group: 0, binding: 0 },
          outputBuffer: { group: 0, binding: 1 },
        },
      },
    );
  }

  public process(
    inputSBO: StorageBuffer,
    outputSBO: StorageBuffer,
    count: number,
  ) {
    this.computeShader.setStorageBuffer("inputBuffer", inputSBO);
    this.computeShader.setStorageBuffer("outputBuffer", outputSBO);
    this.computeShader.dispatch(Math.ceil(count / 64), 1, 1);
  }
}
