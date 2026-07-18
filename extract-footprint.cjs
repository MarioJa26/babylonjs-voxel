"use strict";
/**
 * extract-footprint.cjs
 *
 * Produces a compact structural summary of your TypeScript project,
 * designed to be pasted into Claude as context.
 *
 * This version parses source files with lightweight regex/scanning logic and
 * does NOT depend on the TypeScript compiler API (works with TS 7 native
 * packages that no longer expose the classic node API).
 *
 * Usage:
 *   node extract-footprint.cjs [src-dir] [tsconfig-path] [--loc]
 *   node extract-footprint.cjs src/code
 *   node extract-footprint.cjs src/code --loc
 *
 * Defaults:
 *   src-dir  = ./src
 *   tsconfig = (unused, kept for CLI compatibility)
 *
 * Flags:
 *   --loc    Include per-file and total LOC counts in output
 *
 * Output:
 *   footprint.md
 */
const fs = require("fs");
const path = require("path");
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const rawArgs = process.argv.slice(2);
const includeLoc = rawArgs.includes("--loc");
const positionalArgs = rawArgs.filter((arg) => !arg.startsWith("--"));
const srcDir = path.resolve(positionalArgs[0] ?? "./src");
const outFile = "footprint.md";
const norm = (p) => p.replace(/\\/g, "/");
// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
function collectTsFiles(dir) {
	const results = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (
				entry.name === "node_modules" ||
				entry.name === "dist" ||
				entry.name === ".git"
			) {
				continue;
			}
			results.push(...collectTsFiles(full));
		} else if (
			entry.isFile() &&
			/\.tsx?$/.test(entry.name) &&
			!entry.name.endsWith(".d.ts")
		) {
			results.push(full);
		}
	}
	return results;
}
// ---------------------------------------------------------------------------
// Comment / string stripping
// ---------------------------------------------------------------------------
const STRING_RE = /(["'`])(?:\\.|(?!\1)[\s\S])*\1/g;
const LINE_COMMENT_RE = /\/\/.*$/gm;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
function strip(text) {
	let s = text.replace(STRING_RE, (m) => " " + " ".repeat(m.length - 2) + " ");
	s = s.replace(BLOCK_COMMENT_RE, (m) => " ".repeat(m.length));
	s = s.replace(LINE_COMMENT_RE, "");
	return s;
}
function countLoc(sourceText) {
	const withoutBlockComments = sourceText.replace(BLOCK_COMMENT_RE, "");
	const withoutComments = withoutBlockComments.replace(LINE_COMMENT_RE, "");
	return withoutComments
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0).length;
}
// ---------------------------------------------------------------------------
// Modifier parsing
// ---------------------------------------------------------------------------
const MODIFIER_KINDS = [
	"public",
	"private",
	"protected",
	"static",
	"readonly",
	"abstract",
	"async",
	"export",
	"override",
];
function parseModifiers(text) {
	const found = [];
	for (const m of MODIFIER_KINDS) {
		if (new RegExp("\\b" + m + "\\b").test(text)) found.push(m);
	}
	return found.join(" ");
}
// ---------------------------------------------------------------------------
// Brace-matching helpers
// ---------------------------------------------------------------------------
function findBalanced(text, openIdx) {
	const open = text[openIdx];
	const close =
		open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : null;
	if (close === null) return -1;
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let cur = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "{" || c === "(" || c === "[") depth++;
		else if (c === "}" || c === ")" || c === "]") depth--;
		if (c === "," && depth === 0) {
			parts.push(cur);
			cur = "";
		} else cur += c;
	}
	if (cur.trim().length) parts.push(cur);
	return parts;
}
// ---------------------------------------------------------------------------
// Lightweight analyser
// ---------------------------------------------------------------------------
function analyzeFile(fullPath, rootDir, includeLoc) {
	const raw = fs.readFileSync(fullPath, "utf8");
	const code = strip(raw);
	const entry = {
		relativePath: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
		loc: includeLoc ? countLoc(raw) : undefined,
		classes: [],
		functions: [],
		typeAliases: [],
		interfaces: [],
		enums: [],
	};
	const declRe =
		/(?:^|[\n;])\s*((?:export\s+|abstract\s+|declare\s+)*)(class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/g;
	let m;
	do {
		m = declRe.exec(code);
		if (!m) break;
		const modifiers = m[1];
		const kind = m[2];
		const name = m[3];
		const modText = parseModifiers(modifiers);
		if (kind === "class") {
			const classEntry = {
				name,
				modifiers: modText,
				extends: undefined,
				implements: undefined,
				members: [],
			};
			const after = code.slice(m.index + m[0].length);
			const extMatch =
				/\bextends\s+([\w$.<>,{\s]+?)(?=\s+implements|\s*\{)/.exec(after);
			if (extMatch) {
				classEntry.extends = extMatch[1].trim().replace(/\s+/g, " ");
			}
			const implMatch = /\bimplements\s+([\w$.<>,{\s]+?)\s*\{/.exec(after);
			if (implMatch) {
				classEntry.implements = implMatch[1]
					.trim()
					.replace(/\s+/g, " ")
					.split(",")
					.map((s) => s.trim());
			}
			const braceIdx = code.indexOf("{", m.index + m[0].length);
			if (braceIdx !== -1) {
				const end = findBalanced(code, braceIdx);
				if (end !== -1) {
					const body = code.slice(braceIdx + 1, end);
					classEntry.members = analyzeClassMembers(body);
				}
			}
			entry.classes.push(classEntry);
		} else if (kind === "interface") {
			entry.interfaces.push(name);
		} else if (kind === "enum") {
			entry.enums.push(name);
		} else if (kind === "type") {
			entry.typeAliases.push(name);
		}
	} while (m);
	const fnRe =
		/(?:^|[\n;])\s*((?:export\s+|async\s+|declare\s+)*)function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{]+?))?\s*\{/g;
	do {
		m = fnRe.exec(code);
		if (!m) break;
		const modifiers = m[1];
		const fname = m[2];
		const params = m[3];
		const ret = m[4] ? m[4].trim() : "";
		const modText = parseModifiers(modifiers);
		const sig =
			modText +
			" function " +
			fname +
			"(" +
			formatParams(params) +
			")" +
			(ret ? ": " + ret : "");
		entry.functions.push({ signature: sig.trim() });
	} while (m);
	return entry;
}
function formatParams(rawParams) {
	return splitTopLevel(rawParams)
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.join(", ");
}
const MEMBER_PREFIX_RE =
	/^\s*((?:public\s+|private\s+|protected\s+|readonly\s+|override\s+|static\s+|async\s+|abstract\s+|export\s+)*)/;
const STATEMENT_KW = new Set([
	"if",
	"for",
	"while",
	"switch",
	"do",
	"return",
	"throw",
	"await",
	"new",
	"typeof",
	"case",
	"else",
]);
/**
 * Walk the class body brace-balanced and only treat DIRECT children as
 * members. Nested bodies (method bodies, object literals) are skipped so we
 * don't capture control-flow statements or inline object properties.
 */
function analyzeClassMembers(body) {
	const members = [];
	let i = 0;
	const n = body.length;
	while (i < n) {
		// find next top-level member start: a name-ish token or "get"/"set"/"constructor"
		const prefixMatch = MEMBER_PREFIX_RE.exec(body.slice(i));
		if (!prefixMatch) {
			// skip to next statement boundary
			const nl = body.indexOf("\n", i);
			i = nl === -1 ? n : nl + 1;
			continue;
		}
		const prefix = prefixMatch[1];
		let nameStart = i + prefix.length;
		// skip whitespace
		while (nameStart < n && /\s/.test(body[nameStart])) nameStart++;
		const rest = body.slice(nameStart);
		const headMatch = /^(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(\??)/.exec(
			rest,
		);
		if (!headMatch) {
			const nl = body.indexOf("\n", i);
			i = nl === -1 ? n : nl + 1;
			continue;
		}
		const kw = headMatch[1];
		const optional = headMatch[2];
		// locate the token after the name
		let j = nameStart + headMatch[0].length;
		while (j < n && /\s/.test(body[j])) j++;
		const after = body[j];
		const wholePrefix =
			prefix +
			(headMatch[0].startsWith("get") || headMatch[0].startsWith("set")
				? ""
				: "");
		if (kw === "constructor" && after === "(") {
			const closeParen = findBalanced(body, j);
			const params = closeParen === -1 ? "" : body.slice(j + 1, closeParen);
			members.push({
				kind: "constructor",
				signature: "constructor(" + formatParams(params) + ")",
			});
			i = closeParen === -1 ? n : closeParen + 1;
			continue;
		}
		if (STATEMENT_KW.has(kw)) {
			// not a member; advance past this line
			const nl = body.indexOf("\n", i);
			i = nl === -1 ? n : nl + 1;
			continue;
		}
		if (after === "(") {
			// method or get/set accessor
			const closeParen = findBalanced(body, j);
			const params = closeParen === -1 ? "" : body.slice(j + 1, closeParen);
			let ret = "";
			let k = closeParen === -1 ? n : closeParen + 1;
			while (k < n && /\s/.test(body[k])) k++;
			if (body[k] === ":") {
				let r = k + 1;
				while (r < n && body[r] !== "{" && body[r] !== ";") r++;
				ret = body
					.slice(k + 1, r)
					.trim()
					.replace(/\s+/g, " ");
				k = r;
			}
			while (k < n && /\s/.test(body[k])) k++;
			// arrow method: `name = (...) => { ... }`
			if (body[k] === "=" && body[k + 1] === ">") {
				k = k + 2;
				while (k < n && /\s/.test(body[k])) k++;
			}
			const modText = parseModifiers(prefix + " " + kw);
			const isGet = /^get\s+/.test(rest);
			const isSet = /^set\s+/.test(rest);
			if (isGet) {
				members.push({
					kind: "getter",
					signature: (
						modText +
						" get " +
						kw +
						"()" +
						(ret ? ": " + ret : "")
					).trim(),
				});
			} else if (isSet) {
				members.push({
					kind: "setter",
					signature: (
						modText +
						" set " +
						kw +
						"(" +
						formatParams(params) +
						")"
					).trim(),
				});
			} else {
				members.push({
					kind: "method",
					signature: (
						modText +
						" " +
						kw +
						"(" +
						formatParams(params) +
						")" +
						(ret ? ": " + ret : "")
					).trim(),
				});
			}
			// skip the method body so its contents aren't scanned as members
			if (body[k] === "{") {
				const end = findBalanced(body, k);
				i = end === -1 ? n : end + 1;
			} else {
				const nl = body.indexOf("\n", k);
				i = nl === -1 ? n : nl + 1;
			}
			continue;
		}
		if (after === ":" || after === "?" || after === "=") {
			// property declaration (may be `= <expr>` where expr can contain braces)
			let r = j + 1;
			while (r < n) {
				const c = body[r];
				if (c === "{" || c === "(" || c === "[") {
					const end = findBalanced(body, r);
					if (end === -1) {
						r = n;
						break;
					}
					r = end + 1;
					continue;
				}
				if (c === ";" || c === "\n" || c === "}") break;
				r++;
			}
			let ptype = body
				.slice(j + (after === ":" || after === "?" ? 1 : 0), r)
				.trim()
				.replace(/\s+/g, " ");
			if (after === "=") ptype = "";
			const modText = parseModifiers(prefix + " " + kw);
			members.push({
				kind: "property",
				signature: (
					modText +
					" " +
					kw +
					optional +
					(ptype ? ": " + ptype : "")
				).trim(),
			});
			i = r + 1;
			continue;
		}
		// something else (e.g. a call expression) — skip the line
		const nl = body.indexOf("\n", i);
		i = nl === -1 ? n : nl + 1;
	}
	return members;
}
// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------
function renderMarkdown(files, includeLoc) {
	let totalClasses = 0;
	let totalMembers = 0;
	let totalFunctions = 0;
	let totalLoc = 0;
	const body = [];
	for (const file of files) {
		const hasStructuralContent =
			file.classes.length > 0 ||
			file.functions.length > 0 ||
			file.typeAliases.length > 0 ||
			file.interfaces.length > 0 ||
			file.enums.length > 0;
		const shouldInclude =
			hasStructuralContent ||
			(includeLoc && typeof file.loc === "number" && file.loc > 0);
		if (!shouldInclude) continue;
		if (includeLoc && typeof file.loc === "number") {
			totalLoc += file.loc;
		}
		body.push(
			includeLoc && typeof file.loc === "number"
				? "## `" + file.relativePath + "` (" + file.loc + " LOC)"
				: "## `" + file.relativePath + "`",
		);
		body.push("");
		for (const cls of file.classes) {
			totalClasses++;
			const header = [cls.modifiers, "class", cls.name]
				.filter(Boolean)
				.join(" ");
			const ext = cls.extends ? " extends " + cls.extends : "";
			const impl =
				cls.implements && cls.implements.length
					? " implements " + cls.implements.join(", ")
					: "";
			body.push("### " + header + ext + impl);
			body.push("");
			const ctor = cls.members.filter((mm) => mm.kind === "constructor");
			const props = cls.members.filter((mm) => mm.kind === "property");
			const getset = cls.members.filter(
				(mm) => mm.kind === "getter" || mm.kind === "setter",
			);
			const methods = cls.members.filter((mm) => mm.kind === "method");
			if (ctor.length) {
				body.push("**Constructor**");
				ctor.forEach((mm) => {
					body.push("- `" + mm.signature + "`");
				});
				body.push("");
			}
			if (props.length) {
				body.push("**Properties**");
				props.forEach((mm) => {
					body.push("- `" + mm.signature + "`");
				});
				body.push("");
			}
			if (getset.length) {
				body.push("**Accessors**");
				getset.forEach((mm) => {
					body.push("- `" + mm.signature + "`");
				});
				body.push("");
			}
			if (methods.length) {
				body.push("**Methods**");
				methods.forEach((mm) => {
					body.push("- `" + mm.signature + "`");
				});
				body.push("");
			}
			totalMembers += cls.members.length;
		}
		if (file.functions.length > 0) {
			totalFunctions += file.functions.length;
			body.push("**Module-level functions**");
			file.functions.forEach((fn) => {
				body.push("- `" + fn.signature + "`");
			});
			body.push("");
		}
		const extras = [
			...file.interfaces.map((n) => "interface `" + n + "`"),
			...file.typeAliases.map((n) => "type `" + n + "`"),
			...file.enums.map((n) => "enum `" + n + "`"),
		];
		if (extras.length) {
			body.push("**Types / Interfaces / Enums**");
			extras.forEach((e) => {
				body.push("- " + e);
			});
			body.push("");
		}
		body.push("---");
		body.push("");
	}
	const summary = includeLoc
		? "> **Summary:** " +
			totalClasses +
			" classes · " +
			totalMembers +
			" members · " +
			totalFunctions +
			" module-level functions · " +
			totalLoc +
			" LOC"
		: "> **Summary:** " +
			totalClasses +
			" classes · " +
			totalMembers +
			" members · " +
			totalFunctions +
			" module-level functions";
	return [
		"# Project Footprint",
		"",
		"Generated: " + new Date().toISOString(),
		"",
		summary,
		"",
		"---",
		"",
		...body,
	].join("\n");
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (!fs.existsSync(srcDir)) {
	console.error("Source directory not found: " + srcDir);
	process.exit(1);
}
const tsFiles = collectTsFiles(srcDir);
console.error("Found " + tsFiles.length + " TypeScript files under " + srcDir);
if (tsFiles.length === 0) {
	console.error("No .ts/.tsx files found — check the path argument.");
	process.exit(1);
}
const fileEntries = [];
for (const f of tsFiles) {
	fileEntries.push(analyzeFile(f, srcDir, includeLoc));
}
console.error("Analysed " + fileEntries.length + " files");
fileEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
const markdown = renderMarkdown(fileEntries, includeLoc);
fs.writeFileSync(outFile, markdown, "utf8");
console.error("\nOK Written to " + outFile);
