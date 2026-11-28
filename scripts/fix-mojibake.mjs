import fs from "node:fs";
import path from "node:path";

const MAP = [
	["â†’", "→"],
	["â€”", "—"],
	["â€“", "–"],
	["â€\u009d", "”"],
	["â€œ", "“"],
	["â€™", "’"],
	["âŸº", "⟺"],
	["Â±", "±"],
	["Ã—", "×"],
	["â‰¤", "≤"],
	["â‰¥", "≥"],
	["Â·", "·"],
	["â€\"", "—"],
];

function walk(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p);
		else if (p.endsWith(".ts")) {
			const src = fs.readFileSync(p, "utf8");
			let out = src;
			for (const [bad, good] of MAP) out = out.split(bad).join(good);
			if (out !== src) {
				fs.writeFileSync(p, out, "utf8");
				console.log("fixed", p);
			}
		}
	}
}

walk("src/code");
