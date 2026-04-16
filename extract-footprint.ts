/**
 * extract-footprint.ts
 *
 * Produces a compact structural summary of your TypeScript project,
 * designed to be pasted into Claude as context.
 *
 * Usage:
 *   node extract-footprint.cjs [src-dir] [tsconfig-path] [--loc]
 *   node extract-footprint.cjs src/code
 *   node extract-footprint.cjs src/code --loc
 *   node extract-footprint.cjs --loc src/code ./tsconfig.json
 *
 * Defaults:
 *   src-dir  = ./src
 *   tsconfig = ./tsconfig.json
 *
 * Flags:
 *   --loc    Include per-file and total LOC counts in output
 *
 * Output:
 *   footprint.md (also printed to stdout if you uncomment console.log)
 */

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const includeLoc = rawArgs.includes("--loc");

// Keep only positional args for srcDir / tsconfigPath
const positionalArgs = rawArgs.filter((arg) => !arg.startsWith("--"));

const srcDir = path.resolve(positionalArgs[0] ?? "./src");
const tsconfigPath = path.resolve(positionalArgs[1] ?? "./tsconfig.json");
const outFile = "footprint.md";

/** Normalise to forward-slash for reliable cross-platform comparison. */
const norm = (p: string) => p.replace(/\\/g, "/");

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string): string[] {
	const results: string[] = [];
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
// Helpers
// ---------------------------------------------------------------------------

function getModifiers(node: ts.Node): string {
	const parts: string[] = [];
	const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
	if (!mods) return "";

	for (const mod of mods) {
		switch (mod.kind) {
			case ts.SyntaxKind.PublicKeyword:
				parts.push("public");
				break;
			case ts.SyntaxKind.PrivateKeyword:
				parts.push("private");
				break;
			case ts.SyntaxKind.ProtectedKeyword:
				parts.push("protected");
				break;
			case ts.SyntaxKind.StaticKeyword:
				parts.push("static");
				break;
			case ts.SyntaxKind.ReadonlyKeyword:
				parts.push("readonly");
				break;
			case ts.SyntaxKind.AbstractKeyword:
				parts.push("abstract");
				break;
			case ts.SyntaxKind.AsyncKeyword:
				parts.push("async");
				break;
			case ts.SyntaxKind.ExportKeyword:
				parts.push("export");
				break;
		}
	}

	return parts.join(" ");
}

function returnTypeText(
	node: ts.FunctionLikeDeclaration,
	checker: ts.TypeChecker,
): string {
	if (node.type) return node.type.getText();
	try {
		const sig = checker.getSignatureFromDeclaration(node);
		if (sig) return checker.typeToString(checker.getReturnTypeOfSignature(sig));
	} catch {
		// ignore inference failures
	}
	return "";
}

function formatParams(node: ts.FunctionLikeDeclaration): string {
	return node.parameters
		.map((p) => {
			const name = p.name.getText();
			const optional = p.questionToken ? "?" : "";
			const type = p.type ? p.type.getText() : "unknown";
			const def = p.initializer ? ` = ${p.initializer.getText()}` : "";
			return `${name}${optional}: ${type}${def}`;
		})
		.join(", ");
}

/**
 * Counts logical LOC by:
 * - removing block comments
 * - removing line comments
 * - excluding blank lines
 *
 * This is intentionally lightweight and approximate.
 */
function countLoc(sourceFile: ts.SourceFile): number {
	const text = sourceFile.getFullText();

	// Remove block comments
	const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, "");

	// Remove line comments
	const withoutComments = withoutBlockComments.replace(/\/\/.*$/gm, "");

	// Count non-empty lines
	return withoutComments
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0).length;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

interface MemberEntry {
	kind: "method" | "property" | "constructor" | "getter" | "setter";
	signature: string;
}

interface ClassEntry {
	name: string;
	modifiers: string;
	extends?: string;
	implements?: string[];
	members: MemberEntry[];
}

interface FunctionEntry {
	signature: string;
}

interface FileEntry {
	relativePath: string;
	loc?: number;
	classes: ClassEntry[];
	functions: FunctionEntry[];
	typeAliases: string[];
	interfaces: string[];
	enums: string[];
}

function analyzeFile(
	sourceFile: ts.SourceFile,
	checker: ts.TypeChecker,
	rootDir: string,
	includeLoc: boolean,
): FileEntry {
	const entry: FileEntry = {
		relativePath: path
			.relative(rootDir, sourceFile.fileName)
			.replace(/\\/g, "/"),
		loc: includeLoc ? countLoc(sourceFile) : undefined,
		classes: [],
		functions: [],
		typeAliases: [],
		interfaces: [],
		enums: [],
	};

	function visitClass(
		node: ts.ClassDeclaration | ts.ClassExpression,
	): ClassEntry {
		const name = node.name?.getText() ?? "(anonymous)";
		const mods = getModifiers(node);
		const ext = node.heritageClauses
			?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
			?.types.map((t) => t.getText())
			.join(", ");
		const impl = node.heritageClauses
			?.find((h) => h.token === ts.SyntaxKind.ImplementsKeyword)
			?.types.map((t) => t.getText());

		const classEntry: ClassEntry = {
			name,
			modifiers: mods,
			extends: ext,
			implements: impl,
			members: [],
		};

		for (const member of node.members) {
			const mMods = getModifiers(member);

			if (ts.isConstructorDeclaration(member)) {
				classEntry.members.push({
					kind: "constructor",
					signature: `constructor(${formatParams(member)})`,
				});
			} else if (ts.isMethodDeclaration(member)) {
				const mName = member.name.getText();
				const ret = returnTypeText(member, checker);
				classEntry.members.push({
					kind: "method",
					signature:
						`${mMods} ${mName}(${formatParams(member)})${ret ? `: ${ret}` : ""}`.trim(),
				});
			} else if (ts.isPropertyDeclaration(member)) {
				const pName = member.name.getText();
				const optional = member.questionToken ? "?" : "";
				const pType = member.type ? member.type.getText() : "unknown";
				classEntry.members.push({
					kind: "property",
					signature: `${mMods} ${pName}${optional}: ${pType}`.trim(),
				});
			} else if (ts.isGetAccessorDeclaration(member)) {
				const ret = returnTypeText(member, checker);
				classEntry.members.push({
					kind: "getter",
					signature:
						`${mMods} get ${member.name.getText()}()${ret ? `: ${ret}` : ""}`.trim(),
				});
			} else if (ts.isSetAccessorDeclaration(member)) {
				classEntry.members.push({
					kind: "setter",
					signature:
						`${mMods} set ${member.name.getText()}(${formatParams(member)})`.trim(),
				});
			}
		}

		return classEntry;
	}

	function visit(node: ts.Node) {
		if (ts.isClassDeclaration(node)) {
			entry.classes.push(visitClass(node));
		} else if (ts.isFunctionDeclaration(node) && node.name) {
			const mods = getModifiers(node);
			const ret = returnTypeText(node, checker);
			entry.functions.push({
				signature:
					`${mods} function ${node.name.getText()}(${formatParams(node)})${ret ? `: ${ret}` : ""}`.trim(),
			});
		} else if (ts.isTypeAliasDeclaration(node)) {
			entry.typeAliases.push(node.name.getText());
		} else if (ts.isInterfaceDeclaration(node)) {
			entry.interfaces.push(node.name.getText());
		} else if (ts.isEnumDeclaration(node)) {
			entry.enums.push(node.name.getText());
		}

		ts.forEachChild(node, visit);
	}

	ts.forEachChild(sourceFile, visit);
	return entry;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderMarkdown(files: FileEntry[], includeLoc: boolean): string {
	let totalClasses = 0;
	let totalMembers = 0;
	let totalFunctions = 0;
	let totalLoc = 0;

	const body: string[] = [];

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
				? `## \`${file.relativePath}\` (${file.loc} LOC)`
				: `## \`${file.relativePath}\``,
		);
		body.push("");

		for (const cls of file.classes) {
			totalClasses++;

			const header = [cls.modifiers, "class", cls.name]
				.filter(Boolean)
				.join(" ");

			const ext = cls.extends ? ` extends ${cls.extends}` : "";
			const impl = cls.implements?.length
				? ` implements ${cls.implements.join(", ")}`
				: "";

			body.push(`### ${header}${ext}${impl}`);
			body.push("");

			const ctor = cls.members.filter((m) => m.kind === "constructor");
			const props = cls.members.filter((m) => m.kind === "property");
			const getset = cls.members.filter(
				(m) => m.kind === "getter" || m.kind === "setter",
			);
			const methods = cls.members.filter((m) => m.kind === "method");

			if (ctor.length) {
				body.push("**Constructor**");
				ctor.forEach((m) => body.push(`- \`${m.signature}\``));
				body.push("");
			}

			if (props.length) {
				body.push("**Properties**");
				props.forEach((m) => body.push(`- \`${m.signature}\``));
				body.push("");
			}

			if (getset.length) {
				body.push("**Accessors**");
				getset.forEach((m) => body.push(`- \`${m.signature}\``));
				body.push("");
			}

			if (methods.length) {
				body.push("**Methods**");
				methods.forEach((m) => body.push(`- \`${m.signature}\``));
				body.push("");
			}

			totalMembers += cls.members.length;
		}

		if (file.functions.length > 0) {
			totalFunctions += file.functions.length;
			body.push("**Module-level functions**");
			file.functions.forEach((fn) => body.push(`- \`${fn.signature}\``));
			body.push("");
		}

		const extras = [
			...file.interfaces.map((n) => `interface \`${n}\``),
			...file.typeAliases.map((n) => `type \`${n}\``),
			...file.enums.map((n) => `enum \`${n}\``),
		];

		if (extras.length) {
			body.push("**Types / Interfaces / Enums**");
			extras.forEach((e) => body.push(`- ${e}`));
			body.push("");
		}

		body.push("---");
		body.push("");
	}

	const summary = includeLoc
		? `> **Summary:** ${totalClasses} classes · ${totalMembers} members · ${totalFunctions} module-level functions · ${totalLoc} LOC`
		: `> **Summary:** ${totalClasses} classes · ${totalMembers} members · ${totalFunctions} module-level functions`;

	return [
		"# Project Footprint",
		"",
		`Generated: ${new Date().toISOString()}`,
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
	console.error(`Source directory not found: ${srcDir}`);
	process.exit(1);
}

const tsFiles = collectTsFiles(srcDir);
console.error(`Found ${tsFiles.length} TypeScript files under ${srcDir}`);

if (tsFiles.length === 0) {
	console.error("No .ts/.tsx files found — check the path argument.");
	process.exit(1);
}

let compilerOptions: ts.CompilerOptions = {
	target: ts.ScriptTarget.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Node10,
	allowJs: false,
	strict: false,
	skipLibCheck: true,
};

if (fs.existsSync(tsconfigPath)) {
	console.error(`Using tsconfig: ${tsconfigPath}`);
	const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);

	if (configFile.error) {
		const message = ts.flattenDiagnosticMessageText(
			configFile.error.messageText,
			"\n",
		);
		console.error(`Failed to read tsconfig: ${message}`);
		process.exit(1);
	}

	const parsed = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(tsconfigPath),
	);

	compilerOptions = { ...parsed.options, skipLibCheck: true };
}

const program = ts.createProgram(tsFiles, compilerOptions);
const checker = program.getTypeChecker();

// Normalise paths: the TS compiler uses forward-slashes internally even on Windows,
// but collectTsFiles returns backslash paths on Windows — so we normalise both sides.
const normSrcFiles = new Set(tsFiles.map(norm));

const fileEntries: FileEntry[] = [];
for (const sf of program.getSourceFiles()) {
	if (!sf.isDeclarationFile && normSrcFiles.has(norm(sf.fileName))) {
		fileEntries.push(analyzeFile(sf, checker, srcDir, includeLoc));
	}
}

console.error(`Analysed ${fileEntries.length} files`);
fileEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

const markdown = renderMarkdown(fileEntries, includeLoc);
fs.writeFileSync(outFile, markdown, "utf8");

// Uncomment if you also want stdout output
// console.log(markdown);

console.error(`\n✓ Written to ${outFile}`);
