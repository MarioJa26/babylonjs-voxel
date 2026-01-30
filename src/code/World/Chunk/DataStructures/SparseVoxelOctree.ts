export class SparseVoxelOctree {
  // We use a Uint32Array to store the tree.
  // Format of a node (32-bit integer):
  // - If High Bit (bit 31) is 1: It is a LEAF. The lower 16 bits are the Block ID.
  // - If High Bit (bit 31) is 0: It is a BRANCH. The value is the index in the array where the 8 children start.

  static readonly LEAF_MASK = 0x80000000;
  static readonly DATA_MASK = 0x0000ffff;

  /**
   * Compresses a flat Uint8Array chunk into a Linear SVO (Uint32Array).
   */
  public static compress(blocks: Uint8Array, size: number): Uint32Array {
    const nodes: number[] = [];

    // Helper to build tree recursively
    const build = (x: number, y: number, z: number, s: number): number => {
      // 1. Check if this volume is uniform
      const firstBlock = blocks[x + y * size + z * size * size];
      let uniform = true;

      // Simple scan (can be optimized)
      check: for (let ly = 0; ly < s; ly++) {
        for (let lz = 0; lz < s; lz++) {
          for (let lx = 0; lx < s; lx++) {
            if (
              blocks[x + lx + (y + ly) * size + (z + lz) * size * size] !==
              firstBlock
            ) {
              uniform = false;
              break check;
            }
          }
        }
      }

      // 2. If uniform, return a Leaf Node
      if (uniform) {
        return this.LEAF_MASK | firstBlock;
      }

      // 3. If not uniform, create 8 children
      const half = s / 2;
      // Reserve space for 8 children indices in the nodes array
      const childrenStartIndex = nodes.length;
      // Push placeholders
      for (let i = 0; i < 8; i++) nodes.push(0);

      // Recursively build children
      // Order: X first, then Y, then Z (standard octree order varies, we use simple binary order)
      // 0: 0,0,0
      // 1: 1,0,0
      // 2: 0,1,0
      // 3: 1,1,0
      // 4: 0,0,1
      // ...

      nodes[childrenStartIndex + 0] = build(x, y, z, half);
      nodes[childrenStartIndex + 1] = build(x + half, y, z, half);
      nodes[childrenStartIndex + 2] = build(x, y + half, z, half);
      nodes[childrenStartIndex + 3] = build(x + half, y + half, z, half);
      nodes[childrenStartIndex + 4] = build(x, y, z + half, half);
      nodes[childrenStartIndex + 5] = build(x + half, y, z + half, half);
      nodes[childrenStartIndex + 6] = build(x, y + half, z + half, half);
      nodes[childrenStartIndex + 7] = build(x + half, y + half, z + half, half);

      // Return the index of the children (Branch Node)
      return childrenStartIndex;
    };

    // Start building from root
    const rootNode = build(0, 0, 0, size);

    // The result array needs the root node at the end or we return the array + root index.
    // To keep it simple, we'll prepend the root node or just return the array and assume index 0 is root?
    // Our recursive build pushes children. The root build call returns the "node value".
    // If the whole chunk is uniform, nodes[] is empty.

    // Let's put the root node value at index 0.
    const result = new Uint32Array(nodes.length + 1);
    result[0] = rootNode;
    result.set(nodes, 1);

    return result;
  }

  /**
   * Retrieves a block from the SVO.
   */
  public static getBlock(
    svo: Uint32Array,
    size: number,
    x: number,
    y: number,
    z: number,
  ): number {
    let index = 0; // Start at root (stored at index 0)
    let node = svo[0];
    let s = size;

    let cx = 0,
      cy = 0,
      cz = 0; // Current origin

    while ((node & this.LEAF_MASK) === 0) {
      // If branch, find correct child
      s /= 2;
      // Determine octant (0-7)
      const rx = x - cx >= s ? 1 : 0;
      const ry = y - cy >= s ? 1 : 0;
      const rz = z - cz >= s ? 1 : 0;

      // Update origin for next step
      if (rx) cx += s;
      if (ry) cy += s;
      if (rz) cz += s;

      // Child index = StartIndex + offset + 1 (because we shifted everything by 1 to store root at 0)
      const childOffset = rx + ry * 2 + rz * 4;
      // node value is the index in the original `nodes` array. In `svo`, it's index + 1.
      const pointer = (node & ~this.LEAF_MASK) + 1;

      index = pointer + childOffset;
      node = svo[index];
    }
    return node & this.DATA_MASK;
  }

  /**
   * Retrieves a block from a specific node in the SVO.
   * Coordinates x, y, z are local to the node (0 to size-1).
   */
  public static getBlockFromNode(
    svo: Uint32Array,
    nodeValue: number,
    size: number,
    x: number,
    y: number,
    z: number,
  ): number {
    let node = nodeValue;
    let s = size;
    let cx = 0,
      cy = 0,
      cz = 0;

    while ((node & this.LEAF_MASK) === 0) {
      s /= 2;
      const rx = x - cx >= s ? 1 : 0;
      const ry = y - cy >= s ? 1 : 0;
      const rz = z - cz >= s ? 1 : 0;

      if (rx) cx += s;
      if (ry) cy += s;
      if (rz) cz += s;

      const childOffset = rx + ry * 2 + rz * 4;
      const pointer = (node & ~this.LEAF_MASK) + 1;
      node = svo[pointer + childOffset];
    }
    return node & this.DATA_MASK;
  }

  /**
   * Traverses the SVO and executes a callback for each node.
   * Useful for debugging and visualization.
   */
  public static traverse(
    svo: Uint32Array,
    size: number,
    callback: (
      x: number,
      y: number,
      z: number,
      size: number,
      depth: number,
      isLeaf: boolean,
      blockId: number,
      nodeValue: number,
    ) => boolean | void,
  ): void {
    const traverseRecursive = (
      nodeValue: number,
      x: number,
      y: number,
      z: number,
      s: number,
      depth: number,
    ) => {
      const isLeaf = (nodeValue & this.LEAF_MASK) !== 0;
      const blockId = isLeaf ? nodeValue & this.DATA_MASK : 0;

      // If callback returns false, stop traversing this branch
      if (callback(x, y, z, s, depth, isLeaf, blockId, nodeValue) === false) {
        return;
      }

      if (isLeaf) return;

      const half = s / 2;
      const pointer = (nodeValue & ~this.LEAF_MASK) + 1;

      // Children order matches build()
      for (let i = 0; i < 8; i++) {
        const dx = i & 1 ? half : 0;
        const dy = i & 2 ? half : 0;
        const dz = i & 4 ? half : 0;
        traverseRecursive(
          svo[pointer + i],
          x + dx,
          y + dy,
          z + dz,
          half,
          depth + 1,
        );
      }
    };

    if (svo && svo.length > 0) {
      traverseRecursive(svo[0], 0, 0, 0, size, 0);
    }
  }
}
