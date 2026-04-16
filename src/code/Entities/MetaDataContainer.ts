export class MetadataContainer {
	private entries = new Map<string, unknown>();

	add<T>(type: string, data: T): void {
		this.entries.set(type, data);
	}

	set<T>(type: string, data: T): void {
		this.entries.set(type, data);
	}

	get<T>(type: string): T | undefined {
		return this.entries.get(type) as T | undefined;
	}

	has(type: string): boolean {
		return this.entries.has(type);
	}

	delete(type: string): boolean {
		return this.entries.delete(type);
	}

	getAll(): { type: string; data: any }[] {
		return Array.from(this.entries, ([type, data]) => ({ type, data }));
	}
}
