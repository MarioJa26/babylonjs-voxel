import {
	findLocatableStructure,
	formatLocateResult,
	locateAll,
	locateStructure,
	suggestLocatableStructures,
} from "@/code/Generation/StructureLocator";
import { computeSeedAsInt } from "@/code/Generation/WorldSeed";
import { getWorldNameFromUrl, worldSeedFor } from "@/code/World/WorldContext";

// ---------------------------------------------------------------------------
// `!locate` — shared by both chat front-ends.
//
// There are two independent command dispatchers in this game: PlayerHud's chat
// (singleplayer) and NetworkManager's (multiplayer). They are separate because
// multiplayer chat goes through MultiplayerHUD and the server, but they used to
// be separate implementations too, and they drifted — `/locate` was added to
// one and reported "Unknown command" in the other. The search itself lives in
// Generation/StructureLocator; this module is the command shape on top of it,
// so both front-ends execute literally the same code.
// ---------------------------------------------------------------------------

/** Search radius, in blocks, when the caller does not specify one. */
export const LOCATE_MAX_DISTANCE = 12_000;

const TELEPORT_ARG = "tp";
const ALL_ARG = "all";

export type LocateCommandDeps = {
	/** Search origin in world XZ. */
	originX: number;
	originZ: number;

	/**
	 * Terrain seed string, exactly as the world it describes was seeded.
	 *
	 * In multiplayer this must be the server's seed, not one derived from the
	 * URL. The server generates the world, so a client using its own URL seed
	 * would search a region grid that does not exist and return wrong results.
	 */
	seed: string;

	maxDistance?: number;

	/**
	 * Applies the teleport. Omit for a read-only search. Both front-ends
	 * teleport by writing the local player position, matching `!tp` behavior.
	 */
	onTeleport?: (x: number, z: number) => void;

	/** Where replies go: the singleplayer chat log or multiplayer HUD. */
	reply: (text: string) => void;
};

/**
 * Returns the seed for the world in which the local player is standing.
 *
 * Multiplayer overrides the URL-derived seed with the server-reported seed,
 * because the hosted world is generated from the server's seed.
 */
export function currentWorldSeed(serverSeed: string | null = null): string {
	if (serverSeed !== null) {
		return serverSeed;
	}

	const worldName = getWorldNameFromUrl();
	return worldName === null ? "" : worldSeedFor(worldName);
}

/** Executes the shared `!locate` command. */
export function runLocateCommand(
	args: string[],
	deps: LocateCommandDeps,
): void {
	const { originX, originZ, reply, onTeleport } = deps;
	const maxDistance = deps.maxDistance ?? LOCATE_MAX_DISTANCE;

	if (args.length === 0) {
		reply("Usage: !locate <name> [tp] | !locate all");
		return;
	}

	if (deps.seed === "") {
		reply("No world seed available");
		return;
	}

	const seed = computeSeedAsInt(deps.seed);
	const firstArg = args[0].toLowerCase();

	// `all` lists the nearest instance of every locatable structure.
	if (firstArg === ALL_ARG) {
		const matches = locateAll({
			originX,
			originZ,
			seed,
			maxDistance,
		});

		if (matches.length === 0) {
			reply("No structures found nearby");
			return;
		}

		reply(`Nearest of each structure (${matches.length} found):`);
		for (const match of matches) {
			reply(
				`  ${match.structure.label}: ${match.x} ${match.z} (${Math.round(match.distance)} blocks)`,
			);
		}
		return;
	}

	// Parse the optional teleport flag in one pass and preserve the original
	// behavior of using the first non-`tp` argument as the structure name.
	let wantsTeleport = false;
	let name = "";

	for (const arg of args) {
		if (arg.toLowerCase() === TELEPORT_ARG) {
			wantsTeleport = true;
		} else if (name === "") {
			name = arg;
		}
	}

	const structure = findLocatableStructure(name);
	if (!structure) {
		reply(`Unknown structure: ${name}`);

		const suggestions = suggestLocatableStructures(name);
		if (suggestions.length > 0) {
			reply(`Did you mean: ${suggestions.map(({ key }) => key).join(", ")}?`);
		} else {
			reply("Try !locate all to list every structure");
		}
		return;
	}

	const match = locateStructure(structure, {
		originX,
		originZ,
		seed,
		maxDistance,
	});

	if (!match) {
		reply(`No ${structure.label.toLowerCase()} within ${maxDistance} blocks`);
		return;
	}

	reply(formatLocateResult(match, originX, originZ));

	if (!wantsTeleport) {
		return;
	}

	if (!onTeleport) {
		reply("Teleporting is not available here");
		return;
	}

	onTeleport(match.x, match.z);
	reply(`Teleported to ${match.x} ${match.z}`);
}
