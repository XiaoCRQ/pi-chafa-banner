/**
 * On-disk cache shared by the chafa and image pipelines.
 *
 * Layout: `<pi agent dir>/tmp/pi-chafa-banner/<sha1>/<name>`. Writes go through
 * a `pid`-suffixed temp file plus `rename()` so a concurrent pi (or a killed
 * build) can never leave a half-written JSON that the next run trusts.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { piAgentDir } from "../config.ts";

/** Base directory for every cache entry this extension writes. */
export function cacheRoot(): string {
	return join(piAgentDir(), "tmp", "pi-chafa-banner");
}

/** Cache file for one gif fingerprint (`sha1(path+mtime+size)`). */
export function cacheFilePath(hash: string, name: string): string {
	return join(cacheRoot(), hash, name);
}

/** Parse a cache file; any problem (missing, torn, corrupt) means "rebuild". */
export async function readCacheJson(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Atomic write: readers see either the old file or the new one, never a mix. */
export async function writeCacheJson(path: string, payload: unknown): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		const tmpFile = `${path}.${process.pid}.tmp`;
		await writeFile(tmpFile, JSON.stringify(payload), "utf8");
		await rename(tmpFile, path);
	} catch {
		// Best effort: a read-only ~/.pi must not break the splash.
	}
}

/** Delete exactly one cache file — never a directory tree. */
export async function deleteCacheFile(path: string): Promise<boolean> {
	try {
		await rm(path, { force: true });
		return true;
	} catch {
		return false;
	}
}
