/**
 * ServerWorldStorage — persists block edits to disk per world.
 * Uses simple JSON files in a worlds/ directory.
 * Each world gets one file containing all block edits.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StoredBlockEdit {
	x: number;
	y: number;
	z: number;
	blockId: number;
	action: number; // 0=place, 1=break
	timestamp: number;
}

export class ServerWorldStorage {
	private edits: StoredBlockEdit[] = [];
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private savePending = false;
	private readonly filePath: string;
	private readonly dirPath: string;

	constructor(worldName: string, basePath = "./server-data") {
		this.dirPath = join(basePath, "worlds");
		this.filePath = join(this.dirPath, `${this.sanitize(worldName)}.json`);
	}

	private sanitize(name: string): string {
		return name.replace(/[^a-zA-Z0-9_-]/g, "_");
	}

	async init(): Promise<void> {
		if (!existsSync(this.dirPath)) {
			await mkdir(this.dirPath, { recursive: true });
		}

		try {
			const data = await readFile(this.filePath, "utf-8");
			this.edits = JSON.parse(data);
			console.log(
				`[WorldStorage] Loaded ${this.edits.length} edits for ${this.filePath}`,
			);
		} catch {
			// No existing file — start fresh
			this.edits = [];
		}
	}

	addEdit(edit: StoredBlockEdit): void {
		this.edits.push(edit);

		// Cap at max to prevent unbounded growth
		const MAX_EDITS = 10000;
		if (this.edits.length > MAX_EDITS) {
			this.edits = this.edits.slice(-MAX_EDITS);
		}

		// Debounce saves (save at most once per 5 seconds)
		this.scheduleSave();
	}

	getEdits(): StoredBlockEdit[] {
		return this.edits;
	}

	getEditsSince(timestamp: number): StoredBlockEdit[] {
		return this.edits.filter((e) => e.timestamp > timestamp);
	}

	private scheduleSave(): void {
		this.savePending = true;
		if (this.saveTimer) return; // Already scheduled

		this.saveTimer = setTimeout(() => {
			void this.save();
		}, 5000);
	}

	async save(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.savePending) return;
		this.savePending = false;

		try {
			await writeFile(this.filePath, JSON.stringify(this.edits), "utf-8");
			console.log(
				`[WorldStorage] Saved ${this.edits.length} edits to ${this.filePath}`,
			);
		} catch (err) {
			console.error("[WorldStorage] Save failed:", err);
		}
	}

	async clear(): Promise<void> {
		this.edits = [];
		try {
			await unlink(this.filePath);
		} catch {
			// File doesn't exist — that's fine
		}
	}

	get editCount(): number {
		return this.edits.length;
	}
}
