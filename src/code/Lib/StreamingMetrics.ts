const N = 512;
const ring = new Float64Array(N);
const scratch = new Float64Array(N);
let head = 0;
let count = 0;

export function recordUpdateChunksMs(ms: number): void {
	ring[head] = ms;
	head = (head + 1) % N;
	if (count < N) count++;
}

export function getUpdateChunksPercentiles(out: {
	p50: number;
	p99: number;
	max: number;
}): void {
	if (count === 0) {
		out.p50 = 0;
		out.p99 = 0;
		out.max = 0;
		return;
	}
	for (let i = 0; i < count; i++) scratch[i] = ring[i];
	const v = scratch.subarray(0, count);
	v.sort();
	out.p50 = v[Math.min(count - 1, Math.floor(count * 0.5))];
	out.p99 = v[Math.min(count - 1, Math.floor(count * 0.99))];
	out.max = v[count - 1];
}
