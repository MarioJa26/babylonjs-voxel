import type { PlaceBlockFn } from "../SurfaceGenerator";
import { getFinalTerrainHeight } from "../TerrainHeightMap";
import type { ColumnPrepassResolver } from "./IWorldFeature";

export type DoorSide = "x+" | "x-" | "z+" | "z-";

export interface DoorSpec {
	side: DoorSide;
	width?: number;
	height?: number;
	/** Offset of the door centre along the wall, in blocks from the face centre. */
	offset?: number;
}

export interface HouseOptions {
	cx: number;
	cz: number;
	/** Base Y (floor level) of the house. Usually the lowest ground in the footprint. */
	baseY: number;
	/** Half-extent along X (footprint spans cx-hx..cx+hx). */
	hx: number;
	/** Half-extent along Z (footprint spans cz-hz..cz+hz). */
	hz: number;
	/** Wall height in blocks (floor excluded). */
	height: number;
	wall: number;
	roof: number;
	/** Block used for the floor slab and (by default) the foundation fill. */
	floor: number;
	/** Optional distinct foundation block (e.g. stone) so houses sit on a base. */
	foundation?: number;
	doorSide?: DoorSide;
	doorWidth?: number;
	doorHeight?: number;
	windows?: boolean;
	/** Extra builder callback for chimneys, furniture, etc. */
	extra?: (b: StructureBuilder, baseY: number) => void;
}

/**
 * Shared toolkit for procedural structures. Provides terrain conforming
 * (per-column ground sampling), orientation helpers and coherent building
 * primitives so individual features stay small and readable.
 */
export class StructureBuilder {
	public readonly place: PlaceBlockFn;
	public readonly resolver: ColumnPrepassResolver | undefined;
	public readonly seed: number;

	constructor(
		place: PlaceBlockFn,
		resolver: ColumnPrepassResolver | undefined,
		seed: number,
	) {
		this.place = place;
		this.resolver = resolver;
		this.seed = seed;
	}

	/** Ground (surface) height at a world column, using the prepass when available. */
	ground(wx: number, wz: number): number {
		if (this.resolver) {
			const r = this.resolver(wx, wz);
			return r.entry.terrainHeightMap[r.localX + r.localZ * 32];
		}
		return getFinalTerrainHeight(wx, wz);
	}

	/** Min / max / average ground height over a square footprint. */
	footprintGround(
		cx: number,
		cz: number,
		hx: number,
		hz: number,
	): { min: number; max: number; avg: number } {
		let mn = Infinity;
		let mx = -Infinity;
		// sample sparsely for large footprints
		const step = hx > 8 || hz > 8 ? 2 : 1;
		let sum = 0;
		let n = 0;
		for (let dx = -hx; dx <= hx; dx += step) {
			for (let dz = -hz; dz <= hz; dz += step) {
				const g = this.ground(cx + dx, cz + dz);
				if (g < mn) mn = g;
				if (g > mx) mx = g;
				sum += g;
				n++;
			}
		}
		return { min: mn, max: mx, avg: Math.round(sum / n) };
	}

	set(x: number, y: number, z: number, id: number, ow = true): void {
		this.place(x, y, z, id, ow);
	}

	air(x: number, y: number, z: number): void {
		this.place(x, y, z, 0, true);
	}

	/** Vertical column from baseY up to (but not including) baseY+height. */
	column(
		x: number,
		baseY: number,
		z: number,
		height: number,
		id: number,
		ow = true,
	): void {
		for (let y = 0; y < height; y++) this.place(x, baseY + y, z, id, ow);
	}

	/** Solid box (inclusive world coords). */
	box(
		x0: number,
		y0: number,
		z0: number,
		x1: number,
		y1: number,
		z1: number,
		id: number,
		ow = true,
	): void {
		for (let x = x0; x <= x1; x++)
			for (let y = y0; y <= y1; y++)
				for (let z = z0; z <= z1; z++) this.place(x, y, z, id, ow);
	}

	/** Fill each footprint column from its own ground up to (but not including) baseY. */
	foundation(
		cx: number,
		cz: number,
		hx: number,
		hz: number,
		baseY: number,
		id: number,
		ow = true,
	): void {
		for (let dx = -hx; dx <= hx; dx++) {
			for (let dz = -hz; dz <= hz; dz++) {
				const g = this.ground(cx + dx, cz + dz);
				if (g < baseY) this.column(cx + dx, g, cz + dz, baseY - g, id, ow);
			}
		}
	}

	/** Hollow shell of a box (walls only). `door` carves an opening on one face. */
	shell(
		x0: number,
		y0: number,
		z0: number,
		x1: number,
		y1: number,
		z1: number,
		id: number,
		door?: DoorSpec,
		ow = true,
	): void {
		const dw = door?.width ?? 1;
		const dh = door?.height ?? 2;
		const off = door?.offset ?? 0;
		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) {
				for (let z = z0; z <= z1; z++) {
					const edge = x === x0 || x === x1 || z === z0 || z === z1;
					if (!edge) continue;
					if (
						door &&
						this.inDoor(x, y, z, x0, y0, z0, x1, y1, z1, door, dw, dh, off)
					)
						continue;
					this.place(x, y, z, id, ow);
				}
			}
		}
	}

	private inDoor(
		x: number,
		y: number,
		z: number,
		x0: number,
		y0: number,
		z0: number,
		x1: number,
		_y1: number,
		z1: number,
		door: DoorSpec,
		dw: number,
		dh: number,
		off: number,
	): boolean {
		if (y < y0 || y >= y0 + dh) return false;
		const lo = -Math.floor(dw / 2);
		const hi = dw - 1 + lo;
		switch (door.side) {
			case "x+":
				return (
					x === x1 &&
					z - (z0 + z1) / 2 - off >= lo &&
					z - (z0 + z1) / 2 - off <= hi
				);
			case "x-":
				return (
					x === x0 &&
					z - (z0 + z1) / 2 - off >= lo &&
					z - (z0 + z1) / 2 - off <= hi
				);
			case "z+":
				return (
					z === z1 &&
					x - (x0 + x1) / 2 - off >= lo &&
					x - (x0 + x1) / 2 - off <= hi
				);
			case "z-":
				return (
					z === z0 &&
					x - (x0 + x1) / 2 - off >= lo &&
					x - (x0 + x1) / 2 - off <= hi
				);
		}
	}

	/** Punch a couple of window blocks into the walls at mid height. */
	windowPair(
		x0: number,
		y0: number,
		z0: number,
		x1: number,
		y1: number,
		z1: number,
		glass: number,
	): void {
		const wy = Math.floor((y0 + y1) / 2);
		this.place(x0, wy, Math.floor((z0 + z1) / 2), glass, true);
		this.place(x1, wy, Math.floor((z0 + z1) / 2), glass, true);
		this.place(Math.floor((x0 + x1) / 2), wy, z0, glass, true);
		this.place(Math.floor((x0 + x1) / 2), wy, z1, glass, true);
	}

	/** Circular filled disc in the XZ plane at height y. */
	disc(
		cx: number,
		y: number,
		cz: number,
		radius: number,
		id: number,
		ow = true,
	): void {
		const r2 = radius * radius;
		for (let dx = -radius; dx <= radius; dx++)
			for (let dz = -radius; dz <= radius; dz++)
				if (dx * dx + dz * dz <= r2) this.place(cx + dx, y, cz + dz, id, ow);
	}

	/** Circular wall ring (one block thick) at height y. */
	ring(
		cx: number,
		y: number,
		cz: number,
		radius: number,
		id: number,
		ow = true,
	): void {
		const r2 = radius * radius;
		const ir2 = (radius - 1) * (radius - 1);
		for (let dx = -radius; dx <= radius; dx++)
			for (let dz = -radius; dz <= radius; dz++) {
				const d2 = dx * dx + dz * dz;
				if (d2 <= r2 && d2 > ir2) this.place(cx + dx, y, cz + dz, id, ow);
			}
	}

	/** Rotate a local (dx,dz) offset by 0/90/180/270 degrees (rot: 0..3). */
	static rotate(dx: number, dz: number, rot: number): [number, number] {
		switch (((rot % 4) + 4) % 4) {
			case 1:
				return [dz, -dx];
			case 2:
				return [-dx, -dz];
			case 3:
				return [-dz, dx];
			default:
				return [dx, dz];
		}
	}

	/** Build a coherent small house / hut. */
	buildHouse(o: HouseOptions): void {
		const { cx, cz, baseY, hx, hz, height, wall, roof, floor } = o;
		const x0 = cx - hx;
		const x1 = cx + hx;
		const z0 = cz - hz;
		const z1 = cz + hz;
		const found = o.foundation ?? floor;

		this.foundation(cx, cz, hx, hz, baseY, found);
		this.box(x0, baseY, z0, x1, baseY, z1, floor);
		this.shell(
			x0,
			baseY + 1,
			z0,
			x1,
			baseY + height,
			z1,
			wall,
			o.doorSide
				? {
						side: o.doorSide,
						width: o.doorWidth,
						height: o.doorHeight,
					}
				: undefined,
		);
		if (o.windows)
			this.windowPair(x0, baseY + 1, z0, x1, baseY + height, z1, 60);
		this.box(x0, baseY + height + 1, z0, x1, baseY + height + 1, z1, roof);
		o.extra?.(this, baseY);
	}
}
