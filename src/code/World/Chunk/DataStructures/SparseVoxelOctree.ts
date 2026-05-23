export class SparseVoxelOctree {
	// Node format (32-bit integer):
	// - High bit (31) = 1 → LEAF: lower 16 bits store the packed block value
	// - High bit (31) = 0 → BRANCH: value is the absolute index in the array where 8 children start

	static readonly LEAF_MASK = 0x80000000;
	static readonly DATA_MASK = 0x0000ffff;

	/**
	 * Maximum nodes for a 32^3 fully subdivided octree.
	 * Sum of 8^d for d=0..4 = 1 + 8 + 64 + 512 + 4096 = 4681
	 * (depth 0 = root, depth 4 = 1x1x1 voxels for size=32)
	 */
	static maxNodesForSize(size: number): number {
		const depth = Math.log2(size);
		let total = 0;
		let pow = 1;
		for (let d = 0; d <= depth; d++) {
			total += pow;
			pow *= 8;
		}
		return total;
	}

	/**
	 * Allocates an SVO buffer with enough capacity for the given size.
	 * The returned array has `length` set to 1 (single leaf root).
	 * Use `svo.length` as the used count; the buffer has spare capacity.
	 */
	public static alloc(size: number, fillValue = 0): Uint32Array {
		const capacity = SparseVoxelOctree.maxNodesForSize(size);
		const svo = new Uint32Array(capacity);
		svo[0] =
			SparseVoxelOctree.LEAF_MASK | (fillValue & SparseVoxelOctree.DATA_MASK);
		// Mark used length on the array itself via a hidden property
		(svo as any)._svoLength = 1;
		return svo;
	}

	/** Get the used length of an SVO allocated with alloc(). */
	private static _len(svo: Uint32Array): number {
		return (svo as any)._svoLength ?? svo.length;
	}

	/** Set the used length. */
	private static _setLen(svo: Uint32Array, len: number): void {
		(svo as any)._svoLength = len;
	}

	/**
	 * Creates a minimal SVO (single leaf). Same as alloc but without pre-allocating max capacity.
	 * Use alloc() if you plan to mutate with setBlock().
	 */
	public static create(size: number, fillValue = 0): Uint32Array {
		const svo = new Uint32Array(1);
		svo[0] =
			SparseVoxelOctree.LEAF_MASK | (fillValue & SparseVoxelOctree.DATA_MASK);
		return svo;
	}

	/**
	 * Compresses a flat array of block values into a Linear SVO.
	 * Returns a compact array (no spare capacity).
	 */
	public static compress(
		blocks: Uint8Array | Uint16Array,
		size: number,
	): Uint32Array {
		const nodes: number[] = [];
		const size2 = size * size;

		const build = (x: number, y: number, z: number, s: number): number => {
			const firstBlock = blocks[x + y * size + z * size2];
			let uniform = true;

			check: for (let ly = 0; ly < s; ly++) {
				for (let lz = 0; lz < s; lz++) {
					for (let lx = 0; lx < s; lx++) {
						if (
							blocks[x + lx + (y + ly) * size + (z + lz) * size2] !== firstBlock
						) {
							uniform = false;
							break check;
						}
					}
				}
			}

			if (uniform) {
				return (
					SparseVoxelOctree.LEAF_MASK |
					(firstBlock & SparseVoxelOctree.DATA_MASK)
				);
			}

			const half = s / 2;
			const childrenStartIndex = nodes.length;
			for (let i = 0; i < 8; i++) nodes.push(0);

			nodes[childrenStartIndex + 0] = build(x, y, z, half);
			nodes[childrenStartIndex + 1] = build(x + half, y, z, half);
			nodes[childrenStartIndex + 2] = build(x, y + half, z, half);
			nodes[childrenStartIndex + 3] = build(x + half, y + half, z, half);
			nodes[childrenStartIndex + 4] = build(x, y, z + half, half);
			nodes[childrenStartIndex + 5] = build(x + half, y, z + half, half);
			nodes[childrenStartIndex + 6] = build(x, y + half, z + half, half);
			nodes[childrenStartIndex + 7] = build(x + half, y + half, z + half, half);

			return childrenStartIndex;
		};

		const rootNode = build(0, 0, 0, size);

		const result = new Uint32Array(nodes.length + 1);
		if ((rootNode & SparseVoxelOctree.LEAF_MASK) !== 0) {
			result[0] = rootNode;
		} else {
			result[0] = 1;
			for (let i = 0; i < nodes.length; i++) {
				const val = nodes[i];
				if ((val & SparseVoxelOctree.LEAF_MASK) === 0) {
					result[1 + i] = val + 1;
				} else {
					result[1 + i] = val;
				}
			}
		}

		return result;
	}

	/**
	 * Sets a block value in the SVO in-place.
	 * Requires the SVO to have been allocated with alloc() for spare capacity.
	 */
	public static setBlock(
		svo: Uint32Array,
		size: number,
		x: number,
		y: number,
		z: number,
		blockValue: number,
	): void {
		const packedValue = blockValue & SparseVoxelOctree.DATA_MASK;
		const root = svo[0];

		if ((root & SparseVoxelOctree.LEAF_MASK) !== 0) {
			if ((root & SparseVoxelOctree.DATA_MASK) === packedValue) return;
			// Split root leaf into branch
			const half = size / 2;
			const oldLeaf = root & SparseVoxelOctree.DATA_MASK;
			svo[0] = 1; // children start at index 1
			for (let i = 0; i < 8; i++) {
				const dx = i & 1 ? half : 0;
				const dy = i & 2 ? half : 0;
				const dz = i & 4 ? half : 0;
				const inTarget =
					x >= dx &&
					x < dx + half &&
					y >= dy &&
					y < dy + half &&
					z >= dz &&
					z < dz + half;
				svo[1 + i] = inTarget
					? SparseVoxelOctree.LEAF_MASK | packedValue
					: SparseVoxelOctree.LEAF_MASK | oldLeaf;
			}
			SparseVoxelOctree._setLen(svo, 9);
			return;
		}

		SparseVoxelOctree._setBlockInPlace(
			svo,
			0,
			0,
			0,
			0,
			size,
			x,
			y,
			z,
			packedValue,
		);
	}

	private static _setBlockInPlace(
		svo: Uint32Array,
		nodeIndex: number,
		cx: number,
		cy: number,
		cz: number,
		s: number,
		x: number,
		y: number,
		z: number,
		packedValue: number,
	): void {
		const node = svo[nodeIndex];

		if ((node & SparseVoxelOctree.LEAF_MASK) !== 0) {
			if ((node & SparseVoxelOctree.DATA_MASK) === packedValue) return;
			// Split leaf into branch
			const half = s / 2;
			const oldLeaf = node & SparseVoxelOctree.DATA_MASK;
			const childBase = SparseVoxelOctree._len(svo);
			for (let i = 0; i < 8; i++) {
				const dx = i & 1 ? half : 0;
				const dy = i & 2 ? half : 0;
				const dz = i & 4 ? half : 0;
				const inTarget =
					x >= cx + dx &&
					x < cx + dx + half &&
					y >= cy + dy &&
					y < cy + dy + half &&
					z >= cz + dz &&
					z < cz + dz + half;
				svo[childBase + i] = inTarget
					? SparseVoxelOctree.LEAF_MASK | packedValue
					: SparseVoxelOctree.LEAF_MASK | oldLeaf;
			}
			svo[nodeIndex] = childBase;
			SparseVoxelOctree._setLen(svo, childBase + 8);
			return;
		}

		const half = s / 2;
		const childBase = node;
		const rx = x - cx >= half ? 1 : 0;
		const ry = y - cy >= half ? 1 : 0;
		const rz = z - cz >= half ? 1 : 0;
		const childIdx = rx + ry * 2 + rz * 4;
		const targetChild = childBase + childIdx;

		if (half > 1) {
			SparseVoxelOctree._setBlockInPlace(
				svo,
				targetChild,
				cx + rx * half,
				cy + ry * half,
				cz + rz * half,
				half,
				x,
				y,
				z,
				packedValue,
			);
		} else {
			svo[targetChild] = SparseVoxelOctree.LEAF_MASK | packedValue;
		}
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
		let node = svo[0];
		let s = size;
		let cx = 0,
			cy = 0,
			cz = 0;

		while ((node & SparseVoxelOctree.LEAF_MASK) === 0) {
			s /= 2;
			const rx = x - cx >= s ? 1 : 0;
			const ry = y - cy >= s ? 1 : 0;
			const rz = z - cz >= s ? 1 : 0;

			if (rx) cx += s;
			if (ry) cy += s;
			if (rz) cz += s;

			const childOffset = rx + ry * 2 + rz * 4;
			node = svo[node + childOffset];
		}
		return node & SparseVoxelOctree.DATA_MASK;
	}

	/**
	 * Retrieves a block from a specific node in the SVO.
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

		while ((node & SparseVoxelOctree.LEAF_MASK) === 0) {
			s /= 2;
			const rx = x - cx >= s ? 1 : 0;
			const ry = y - cy >= s ? 1 : 0;
			const rz = z - cz >= s ? 1 : 0;

			if (rx) cx += s;
			if (ry) cy += s;
			if (rz) cz += s;

			const childOffset = rx + ry * 2 + rz * 4;
			node = svo[node + childOffset];
		}
		return node & SparseVoxelOctree.DATA_MASK;
	}

	/**
	 * Traverses the SVO depth-first. Returning false prunes the branch.
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
			const isLeaf = (nodeValue & SparseVoxelOctree.LEAF_MASK) !== 0;
			const blockId = isLeaf ? nodeValue & SparseVoxelOctree.DATA_MASK : 0;

			if (callback(x, y, z, s, depth, isLeaf, blockId, nodeValue) === false) {
				return;
			}

			if (isLeaf) return;

			const half = s / 2;
			for (let i = 0; i < 8; i++) {
				const dx = i & 1 ? half : 0;
				const dy = i & 2 ? half : 0;
				const dz = i & 4 ? half : 0;
				traverseRecursive(
					svo[nodeValue + i],
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

	/**
	 * Extracts the SVO into a flat Uint16Array for compatibility/debugging.
	 */
	public static extractFlat(svo: Uint32Array, size: number): Uint16Array {
		const total = size * size * size;
		const flat = new Uint16Array(total);
		const size2 = size * size;

		const fill = (
			nodeValue: number,
			x: number,
			y: number,
			z: number,
			s: number,
		) => {
			const isLeaf = (nodeValue & SparseVoxelOctree.LEAF_MASK) !== 0;
			if (isLeaf) {
				const val = nodeValue & SparseVoxelOctree.DATA_MASK;
				for (let ly = 0; ly < s; ly++) {
					for (let lz = 0; lz < s; lz++) {
						for (let lx = 0; lx < s; lx++) {
							flat[x + lx + (y + ly) * size + (z + lz) * size2] = val;
						}
					}
				}
				return;
			}

			const half = s / 2;
			for (let i = 0; i < 8; i++) {
				const dx = i & 1 ? half : 0;
				const dy = i & 2 ? half : 0;
				const dz = i & 4 ? half : 0;
				fill(svo[nodeValue + i], x + dx, y + dy, z + dz, half);
			}
		};

		fill(svo[0], 0, 0, 0, size);
		return flat;
	}
}
