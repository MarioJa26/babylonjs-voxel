import type { Player } from "../Player/Player";

export interface IUsable {
	use(player?: Player): void;
}
