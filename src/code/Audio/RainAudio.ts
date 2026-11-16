import { getAudioOutput } from "./AudioManager";
import {
	computeRainMix,
	RAIN_BODY_FREQ,
	RAIN_CROSSFADE_SECONDS,
	RAIN_HISS_FREQ,
	RAIN_NOISE_SECONDS,
	RAIN_OPEN_CUTOFF,
	RAIN_PATTER_FREQ,
	RAIN_RAMP_SECONDS,
} from "./RainAudioMix";

interface RainGraph {
	context: BaseAudioContext;
	source: AudioBufferSourceNode;
	bus: GainNode;
	muffle: BiquadFilterNode;
	bodyFilter: BiquadFilterNode;
	bodyGain: GainNode;
	hissFilter: BiquadFilterNode;
	hissGain: GainNode;
	patterFilter: BiquadFilterNode;
	patterGain: GainNode;
}

interface ScheduledValues {
	bodyGain: number;
	hissGain: number;
	patterGain: number;
	exposureGain: number;
	cutoff: number;
}

let graph: RainGraph | null = null;
let failedContext: BaseAudioContext | null = null;

const scheduled: ScheduledValues = {
	bodyGain: -1,
	hissGain: -1,
	patterGain: -1,
	exposureGain: -1,
	cutoff: -1,
};

const PARAM_EPSILON = 0.002;
const RANDOM_SCALE = 1 / 0x100000000;
const TWO_PI = Math.PI * 2;

function resetScheduledValues(): void {
	scheduled.bodyGain = -1;
	scheduled.hissGain = -1;
	scheduled.patterGain = -1;
	scheduled.exposureGain = -1;
	scheduled.cutoff = -1;
}

function buildSeamlessNoise(context: BaseAudioContext): AudioBuffer {
	const sampleRate = context.sampleRate;
	const length = Math.max(1, Math.floor(sampleRate * RAIN_NOISE_SECONDS));

	const crossfadeLength = Math.min(
		Math.floor(sampleRate * RAIN_CROSSFADE_SECONDS),
		length >>> 1,
	);

	const buffer = context.createBuffer(1, length, sampleRate);
	const data = buffer.getChannelData(0);

	// Deterministic Mulberry32-style generator, isolated from game RNG state.
	let rng = 0x6d2b79f5;

	const random = (): number => {
		rng = (rng + 0x6d2b79f5) | 0;

		let value = Math.imul(rng ^ (rng >>> 15), 1 | rng);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);

		return ((value ^ (value >>> 14)) >>> 0) * RANDOM_SCALE;
	};

	/*
	 * Continuous rain bed.
	 *
	 * Separate random samples keep the low and mid components decorrelated,
	 * preventing synchronized transients from emphasizing clicks.
	 */
	let low = 0;
	let mid = 0;
	let gust = 0;

	for (let i = 0; i < length; i++) {
		low += (random() * 2 - 1 - low) * 0.005;
		mid += (random() * 2 - 1 - mid) * 0.09;
		gust += (random() * 2 - 1 - gust) * 0.0012;

		const limitedGust = Math.max(-0.18, Math.min(0.28, gust));

		data[i] = (low * 0.72 + mid * 0.52) * (0.78 + limitedGust);
	}

	/*
	 * Add diffuse, filtered surface splashes.
	 */
	const dropCount = Math.floor(RAIN_NOISE_SECONDS * 80);
	const startRange = Math.max(1, length - 1);

	for (let drop = 0; drop < dropCount; drop++) {
		const start = Math.floor(random() * startRange);
		const durationSeconds = 0.045 + random() * 0.095;
		const grainLength = Math.max(1, Math.floor(sampleRate * durationSeconds));

		const attackLength = Math.max(
			1,
			Math.floor(sampleRate * (0.003 + random() * 0.005)),
		);

		const levelRandom = random();
		const amplitude = 0.07 + levelRandom * levelRandom * 0.2;

		const cutoff = 900 + random() * 1700;
		const filterCoefficient = 1 - Math.exp((-TWO_PI * cutoff) / sampleRate);

		const bodyFrequency = 250 + random() * 500;
		const bodyCoefficient =
			1 - Math.exp((-TWO_PI * bodyFrequency) / sampleRate);

		const decaySeconds = 0.018 + random() * 0.045;
		const decayCoefficient = Math.exp(
			-1 / Math.max(1, sampleRate * decaySeconds),
		);

		const attackPhaseStep = (Math.PI * 0.5) / attackLength;

		let filteredNoise = 0;
		let splashBody = 0;
		let envelope = 1;

		for (let sample = 0; sample < grainLength; sample++) {
			const index = (start + sample) % length;
			const noise = random() * 2 - 1;

			filteredNoise += (noise - filteredNoise) * filterCoefficient;

			splashBody += (filteredNoise - splashBody) * bodyCoefficient;

			const attack =
				sample < attackLength ? Math.sin(sample * attackPhaseStep) : 1;

			const texture = 0.82 + random() * 0.18;
			const splash = filteredNoise * 0.68 + splashBody * 0.32;

			data[index] += splash * attack * envelope * amplitude * texture;

			envelope *= decayCoefficient;
		}
	}

	// Soft limiting avoids sharp high-frequency edges from hard clipping.
	for (let i = 0; i < length; i++) {
		data[i] = Math.tanh(data[i] * 1.15) / 1.15;
	}

	if (crossfadeLength > 0) {
		const tailStart = length - crossfadeLength;
		const inverseFadeLength =
			crossfadeLength > 1 ? 1 / (crossfadeLength - 1) : 1;

		for (let i = 0; i < crossfadeLength; i++) {
			const mix = i * inverseFadeLength;
			const tailIndex = tailStart + i;
			const headSample = data[crossfadeLength - 1 - i];

			data[tailIndex] += (headSample - data[tailIndex]) * mix;
		}
	}

	return buffer;
}

function safeDisconnect(node: AudioNode): void {
	try {
		node.disconnect();
	} catch {
		// Best-effort cleanup.
	}
}

function destroyGraph(currentGraph: RainGraph): void {
	try {
		currentGraph.source.stop();
	} catch {
		// The source may not have started or may already be stopped.
	}

	safeDisconnect(currentGraph.source);
	safeDisconnect(currentGraph.bodyFilter);
	safeDisconnect(currentGraph.bodyGain);
	safeDisconnect(currentGraph.hissFilter);
	safeDisconnect(currentGraph.hissGain);
	safeDisconnect(currentGraph.patterFilter);
	safeDisconnect(currentGraph.patterGain);
	safeDisconnect(currentGraph.bus);
	safeDisconnect(currentGraph.muffle);
}

function clearGraph(): void {
	if (graph !== null) {
		destroyGraph(graph);
		graph = null;
	}

	resetScheduledValues();
}

function createGraph(
	context: BaseAudioContext,
	output: AudioNode,
): RainGraph | null {
	const createdNodes: AudioNode[] = [];
	let source: AudioBufferSourceNode | null = null;

	try {
		const buffer = buildSeamlessNoise(context);

		source = context.createBufferSource();
		source.buffer = buffer;
		source.loop = true;
		createdNodes.push(source);

		const bodyFilter = context.createBiquadFilter();
		bodyFilter.type = "lowpass";
		bodyFilter.frequency.value = RAIN_BODY_FREQ;
		createdNodes.push(bodyFilter);

		const bodyGain = context.createGain();
		bodyGain.gain.value = 0;
		createdNodes.push(bodyGain);

		const hissFilter = context.createBiquadFilter();
		hissFilter.type = "bandpass";
		hissFilter.frequency.value = RAIN_HISS_FREQ;
		hissFilter.Q.value = 0.6;
		createdNodes.push(hissFilter);

		const hissGain = context.createGain();
		hissGain.gain.value = 0;
		createdNodes.push(hissGain);

		const patterFilter = context.createBiquadFilter();
		patterFilter.type = "highpass";
		patterFilter.frequency.value = RAIN_PATTER_FREQ;
		createdNodes.push(patterFilter);

		const patterGain = context.createGain();
		patterGain.gain.value = 0;
		createdNodes.push(patterGain);

		const bus = context.createGain();
		bus.gain.value = 0;
		createdNodes.push(bus);

		const muffle = context.createBiquadFilter();
		muffle.type = "lowpass";
		muffle.frequency.value = RAIN_OPEN_CUTOFF;
		muffle.Q.value = 0.7;
		createdNodes.push(muffle);

		source.connect(bodyFilter);
		bodyFilter.connect(bodyGain);
		bodyGain.connect(bus);

		source.connect(hissFilter);
		hissFilter.connect(hissGain);
		hissGain.connect(bus);

		source.connect(patterFilter);
		patterFilter.connect(patterGain);
		patterGain.connect(bus);

		bus.connect(muffle);
		muffle.connect(output);

		source.start();

		return {
			context,
			source,
			bus,
			muffle,
			bodyFilter,
			bodyGain,
			hissFilter,
			hissGain,
			patterFilter,
			patterGain,
		};
	} catch {
		try {
			source?.stop();
		} catch {
			// The source may not have started.
		}

		for (const node of createdNodes) {
			safeDisconnect(node);
		}

		return null;
	}
}

function ensureGraph(): RainGraph | null {
	const output = getAudioOutput();

	if (!output) {
		return null;
	}

	const context = output.context;

	if (graph?.context === context) {
		return graph;
	}

	if (failedContext === context) {
		return null;
	}

	clearGraph();

	const nextGraph = createGraph(context, output);

	if (nextGraph === null) {
		failedContext = context;
		return null;
	}

	graph = nextGraph;
	failedContext = null;
	resetScheduledValues();

	return nextGraph;
}

function scheduleTarget(
	param: AudioParam,
	value: number,
	previousValue: number,
	now: number,
): number {
	if (Math.abs(value - previousValue) < PARAM_EPSILON) {
		return previousValue;
	}

	param.setTargetAtTime(value, now, RAIN_RAMP_SECONDS);
	return value;
}

/**
 * Update the procedural rain bed.
 *
 * @param intensity Rain intensity in the range 0..1.
 * @param exposure Amount of rain reaching the listener in the range 0..1.
 */
export function updateRainAudio(intensity: number, exposure: number): void {
	const mix = computeRainMix(intensity, exposure);

	const audible =
		mix.exposureGain > 0 &&
		(mix.bodyGain > 0 || mix.hissGain > 0 || mix.patterGain > 0);

	// Do not allocate the buffer until rain first becomes audible.
	if (!audible && graph === null) {
		return;
	}

	const currentGraph = ensureGraph();

	if (currentGraph === null) {
		return;
	}

	const now = currentGraph.context.currentTime;

	scheduled.bodyGain = scheduleTarget(
		currentGraph.bodyGain.gain,
		mix.bodyGain,
		scheduled.bodyGain,
		now,
	);

	scheduled.hissGain = scheduleTarget(
		currentGraph.hissGain.gain,
		mix.hissGain,
		scheduled.hissGain,
		now,
	);

	scheduled.patterGain = scheduleTarget(
		currentGraph.patterGain.gain,
		mix.patterGain,
		scheduled.patterGain,
		now,
	);

	scheduled.exposureGain = scheduleTarget(
		currentGraph.bus.gain,
		mix.exposureGain,
		scheduled.exposureGain,
		now,
	);

	scheduled.cutoff = scheduleTarget(
		currentGraph.muffle.frequency,
		mix.cutoff,
		scheduled.cutoff,
		now,
	);
}

/**
 * Stop the rain bed and release all associated audio nodes.
 */
export function disposeRainAudio(): void {
	clearGraph();

	// Explicit disposal permits a retry using the same context.
	failedContext = null;
}
