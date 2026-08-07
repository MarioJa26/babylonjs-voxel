import { register } from "node:module";
register("tsx/esm", import.meta.url, { data: {} });
await import("./chunkWorker.ts");
