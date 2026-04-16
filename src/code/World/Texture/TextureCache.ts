export class TextureCache {
	private static dbName = "TextureCache";
	private static storeName = "textures";
	private static dbPromise: Promise<IDBDatabase> | null = null;

	private static getDB(): Promise<IDBDatabase> {
		if (TextureCache.dbPromise) return TextureCache.dbPromise;

		TextureCache.dbPromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(TextureCache.dbName, 1);
			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains(TextureCache.storeName)) {
					db.createObjectStore(TextureCache.storeName);
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return TextureCache.dbPromise;
	}

	static async get(url: string): Promise<Blob | undefined> {
		try {
			const db = await TextureCache.getDB();
			return new Promise((resolve, reject) => {
				const tx = db.transaction(TextureCache.storeName, "readonly");
				const store = tx.objectStore(TextureCache.storeName);
				const req = store.get(url);
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			});
		} catch (e) {
			console.warn("TextureCache get failed", e);
			return undefined;
		}
	}

	static async put(url: string, blob: Blob): Promise<void> {
		try {
			const db = await TextureCache.getDB();
			return new Promise((resolve, reject) => {
				const tx = db.transaction(TextureCache.storeName, "readwrite");
				const store = tx.objectStore(TextureCache.storeName);
				const req = store.put(blob, url);
				req.onsuccess = () => resolve();
				req.onerror = () => reject(req.error);
			});
		} catch (e) {
			console.warn("TextureCache put failed", e);
		}
	}
}
