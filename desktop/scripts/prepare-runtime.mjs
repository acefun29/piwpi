import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createPackageWithOptions } = require("@electron/asar");

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "..");
const runtime = join(desktop, "build", "runtime");
const runtimeArchive = join(desktop, "build", "runtime.asar");
const runtimeModules = join(runtime, "node_modules");
const rootModules = join(repo, "node_modules");
const internalPackages = new Map([
	["@earendil-works/pi-ai", "ai"],
	["@earendil-works/pi-agent-core", "agent"],
	["@earendil-works/pi-tui", "tui"],
	["@earendil-works/pi-protocol", "protocol"],
	["@earendil-works/pi-client", "client"],
	["@earendil-works/pi-coding-agent", "coding-agent"],
]);

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function dependencyNames(packageJson) {
	const required = new Set([
		...Object.keys(packageJson.dependencies ?? {}),
		...Object.keys(packageJson.peerDependencies ?? {}).filter(
			(name) => packageJson.peerDependenciesMeta?.[name]?.optional !== true,
		),
		...(packageJson.bundleDependencies ?? packageJson.bundledDependencies ?? []),
	]);
	const optional = new Set(Object.keys(packageJson.optionalDependencies ?? {}));
	return { required, optional };
}

async function resolveInstalledPackage(fromDirectory, name) {
	let cursor = fromDirectory;
	for (;;) {
		const candidate = join(cursor, "node_modules", ...name.split("/"));
		if (await exists(join(candidate, "package.json"))) return candidate;
		const parent = dirname(cursor);
		if (parent === cursor) return undefined;
		cursor = parent;
	}
}

function stripLongPathPrefix(p) {
	if (typeof p !== "string") return p;
	return p.startsWith("\\\\?\\") ? p.slice(4) : p;
}

async function copyExternalPackage(source) {
	const modulePath = relative(rootModules, source);
	if (!modulePath || modulePath.startsWith(`..${sep}`) || modulePath === "..") {
		throw new Error(`Production dependency is outside root node_modules: ${source}`);
	}
	const target = join(runtimeModules, modulePath);
	await mkdir(dirname(target), { recursive: true });
	await cp(source, target, {
		recursive: true,
		dereference: true,
		filter(src) {
			const cleanSrc = stripLongPathPrefix(src);
			const cleanSource = stripLongPathPrefix(source);
			const childPath = relative(cleanSource, cleanSrc);
			if (!childPath) return true;
			return !childPath.split(sep).includes("node_modules");
		},
	});
}

async function copyInternalPackage(name, directory) {
	const source = join(repo, "packages", directory);
	const target = join(runtimeModules, ...name.split("/"));
	await mkdir(target, { recursive: true });
	await cp(join(source, "dist"), join(target, "dist"), { recursive: true, dereference: true });
	const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
	await writeFile(join(target, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
	return { source, packageJson };
}

async function countRuntimeFiles(directory) {
	let files = 0;
	let bytes = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			const child = await countRuntimeFiles(path);
			files += child.files;
			bytes += child.bytes;
		} else if (entry.isFile()) {
			files++;
			bytes += (await stat(path)).size;
		}
	}
	return { files, bytes };
}

await rm(runtime, { recursive: true, force: true });
await mkdir(runtimeModules, { recursive: true });

const queue = [];
for (const [name, directory] of internalPackages) {
	const copied = await copyInternalPackage(name, directory);
	queue.push({ name, ...copied });
}

const copiedExternalSources = new Set();
for (let index = 0; index < queue.length; index++) {
	const current = queue[index];
	const { required, optional } = dependencyNames(current.packageJson);
	for (const name of new Set([...required, ...optional])) {
		if (internalPackages.has(name)) continue;
		const source = await resolveInstalledPackage(current.source, name);
		if (!source) {
			if (optional.has(name)) continue;
			throw new Error(`Missing production dependency ${name} required by ${current.name}`);
		}
		if (copiedExternalSources.has(source)) continue;
		copiedExternalSources.add(source);
		await copyExternalPackage(source);
		queue.push({
			name,
			source,
			packageJson: JSON.parse(await readFile(join(source, "package.json"), "utf8")),
		});
	}
}

const totals = await countRuntimeFiles(runtime);
await rm(runtimeArchive, { force: true });
await rm(`${runtimeArchive}.unpacked`, { recursive: true, force: true });
await createPackageWithOptions(runtime, runtimeArchive, { unpack: "**/*.{node,dll,exe}" });
const archiveBytes = (await stat(runtimeArchive)).size;
const unpackedTotals = (await exists(`${runtimeArchive}.unpacked`))
	? await countRuntimeFiles(`${runtimeArchive}.unpacked`)
	: { files: 0, bytes: 0 };

console.log(`Prepared piwpi runtime at ${runtime}`);
console.log(
	`Included ${internalPackages.size} internal packages and ${copiedExternalSources.size} production packages ` +
		`(${totals.files} files, ${(totals.bytes / 1024 / 1024).toFixed(1)} MB)`,
);
console.log(
	`Packed runtime.asar (${(archiveBytes / 1024 / 1024).toFixed(1)} MB) with ` +
		`${unpackedTotals.files} native files (${(unpackedTotals.bytes / 1024 / 1024).toFixed(1)} MB)`,
);
