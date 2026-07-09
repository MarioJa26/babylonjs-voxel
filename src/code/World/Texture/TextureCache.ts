const dbName = "TextureCache";
const storeName = "textures";
let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;

	dbPromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(dbName, 1);
		request.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(storeName)) {
				db.createObjectStore(storeName);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	return dbPromise;
}

export async function getTextureCache(url: string): Promise<Blob | undefined> {
	try {
		const db = await getDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, "readonly");
			const store = tx.objectStore(storeName);
			const req = store.get(url);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	} catch (e) {
		console.warn("TextureCache get failed", e);
		return undefined;
	}
}

export async function putTextureCache(url: string, blob: Blob): Promise<void> {
	try {
		const db = await getDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(storeName, "readwrite");
			const store = tx.objectStore(storeName);
			const req = store.put(blob, url);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	} catch (e) {
		console.warn("TextureCache put failed", e);
	}
}
