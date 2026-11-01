import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, writeFile, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { resourceSource } from "./resources.js";
import { setTimeout as delay } from "node:timers/promises";

type Manifest = { schema: number; algorithm: string; count: number; files: string[]; hashes: Record<string, string>; sizes?: Record<string, number> };
type Entry = { path: string; size: number; hash: string; offset: number };
type Source = { hash: string; size?: number; entry?: Entry };
export type UpdateState = {
	phase: "loading-package" | "checking" | "updating" | "ready" | "failed";
	version?: string;
	total: number;
	completed: number;
	reused: number;
	downloaded: number;
};
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function validPath(path: unknown): path is string {
	if (typeof path !== "string" || !/^\/[^/]/.test(path) || /[\s\\?#\x00-\x1f]/.test(path)) return false;
	try {
		const decoded = decodeURIComponent(path);
		return !/[\\?#\x00-\x1f]/.test(decoded) && !decoded.split("/").some((part) => part === "." || part === "..");
	} catch {
		return false;
	}
}
function parseManifest(text: string): Manifest {
	const m = JSON.parse(text) as Manifest;
	if (
		!m ||
		m.schema !== 2 ||
		m.algorithm !== "sha256" ||
		!Array.isArray(m.files) ||
		m.count !== m.files.length ||
		!m.hashes ||
		new Set(m.files).size !== m.count ||
		!m.count
	)
		throw new Error("资源清单格式不受支持");
	for (const path of m.files) {
		if (
			!validPath(path) ||
			!/^[a-f0-9]{64}$/.test(m.hashes[path] ?? "") ||
			(m.sizes?.[path] !== undefined && (!Number.isSafeInteger(m.sizes[path]) || m.sizes[path] < 0))
		)
			throw new Error("资源清单校验信息无效");
	}
	return m;
}
function verify(bytes: Uint8Array, hash: string, size?: number) {
	if ((size !== undefined && bytes.length !== size) || digest(bytes) !== hash) throw new Error("游戏资源完整性校验失败");
}
async function readRange(file: FileHandle, offset: number, size: number) {
	const bytes = Buffer.alloc(size);
	let done = 0;
	while (done < size) {
		const { bytesRead } = await file.read(bytes, done, size - done, offset + done);
		if (!bytesRead) throw new Error("本地包体不完整");
		done += bytesRead;
	}
	return bytes;
}
async function packageIndex(file: FileHandle) {
	const header = await readRange(file, 0, 44);
	const length = header.readUInt32BE(8);
	if (header.subarray(0, 8).toString() !== "SMKPACK1" || length > 8 * 1024 * 1024 || !length) throw new Error("本地包体格式无效");
	const bytes = await readRange(file, 44, length);
	verify(bytes, header.subarray(12).toString("hex"));
	const meta = JSON.parse(bytes.toString());
	if (meta.format !== 1 || meta.app !== "SanmeiKill" || !Array.isArray(meta.entries)) throw new Error("本地包体元数据无效");
	const manifest = parseManifest(meta.manifest);
	const allowed = new Set([...manifest.files, "/index.html"]);
	const entries = new Map<string, Entry>();
	let offset = 44 + length;
	for (const e of meta.entries) {
		if (
			!validPath(e.path) ||
			!allowed.has(e.path) ||
			entries.has(e.path) ||
			!Number.isSafeInteger(e.size) ||
			e.size < 0 ||
			!/^[a-f0-9]{64}$/.test(e.hash)
		)
			throw new Error("本地包体文件清单无效");
		if (
			e.path !== "/index.html" &&
			(e.hash !== manifest.hashes[e.path] || (manifest.sizes?.[e.path] !== undefined && e.size !== manifest.sizes[e.path]))
		)
			throw new Error("本地包体与清单不一致");
		entries.set(e.path, { ...e, offset });
		offset += e.size;
		if (!Number.isSafeInteger(offset)) throw new Error("本地包体大小无效");
	}
	if (entries.size !== allowed.size || offset !== (await file.stat()).size) throw new Error("本地包体不完整");
	return entries;
}

/** Owns an immutable, verified resource snapshot. No game source is returned by CLI commands. */
export class ResourceUpdater {
	state: UpdateState = { phase: "checking", total: 0, completed: 0, reused: 0, downloaded: 0 };
	private file?: FileHandle;
	private sources = new Map<string, Source>();
	private shell?: Buffer;
	private manifestText = "";
	private readonly abort = new AbortController();
	readonly base: URL;
	constructor(readonly options: { site: string; package?: string; cache: string; onState?: (state: UpdateState) => void }) {
		this.base = new URL("./", resourceSource(options.site, options.package).site);
	}
	private publish() {
		this.options.onState?.({ ...this.state });
	}
	private async fetchBytes(path: string, maxBytes: number) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.fetchAttempt(path, maxBytes);
			} catch (error) {
				if (attempt >= 2 || this.abort.signal.aborted) throw error;
				await delay(250 * (attempt + 1), undefined, { signal: this.abort.signal });
			}
		}
	}
	private async fetchAttempt(path: string, maxBytes: number) {
		const response = await fetch(new URL(path.replace(/^\//, ""), this.base), {
			cache: "no-store",
			redirect: "error",
			signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(60000)]),
		});
		if (!response.ok || !response.body) throw new Error(`更新服务器请求失败（HTTP ${response.status}）`);
		const chunks: Uint8Array[] = [];
		let length = 0;
		const reader = response.body.getReader();
		try {
			while (true) {
				const { value: chunk, done } = await reader.read();
				if (done) break;
				length += chunk.length;
				if (length > maxBytes) throw new Error("更新资源超过允许大小");
				chunks.push(chunk);
			}
		} finally {
			await reader.cancel();
		}
		return Buffer.concat(chunks);
	}
	private async remoteVersion() {
		const version = (await this.fetchBytes("version", 128)).toString().trim();
		if (!/^\d{1,20}$/.test(version)) throw new Error("更新服务器版本号无效");
		return version;
	}
	async prepare() {
		try {
			let local = new Map<string, Entry>();
			if (this.options.package) {
				this.state.phase = "loading-package";
				this.publish();
				this.file = await open(this.options.package, "r");
				local = await packageIndex(this.file);
			}
			this.state.phase = "checking";
			this.publish();
			const version = await this.remoteVersion();
			this.manifestText = (await this.fetchBytes("cache-manifest.json", 8 * 1024 * 1024)).toString();
			const manifest = parseManifest(this.manifestText);
			await mkdir(this.options.cache, { recursive: true, mode: 0o700 });
			this.state = { ...this.state, phase: "updating", version, total: manifest.count };
			this.publish();
			let cursor = 0;
			let failure: unknown;
			await Promise.all(
				Array.from({ length: 8 }, async () => {
					while (!failure && cursor < manifest.files.length) {
						const path = manifest.files[cursor++];
						try {
							const hash = manifest.hashes[path];
							const size = manifest.sizes?.[path];
							const entry = local.get(path);
							if (entry?.hash === hash && this.file) {
								verify(await readRange(this.file, entry.offset, entry.size), hash, size);
								this.sources.set(path, { hash, size, entry });
								this.state.reused++;
							} else {
								const destination = join(this.options.cache, hash);
								let cached = false;
								try {
									verify(await readFile(destination), hash, size);
									cached = true;
								} catch {
									/* Missing or damaged blobs must be downloaded again. */
								}
								if (cached) this.state.reused++;
								else {
									const bytes = await this.fetchBytes(path, size ?? 256 * 1024 * 1024);
									verify(bytes, hash, size);
									const temporary = destination + "." + randomUUID() + ".tmp";
									try {
										await writeFile(temporary, bytes, { mode: 0o600 });
										await rename(temporary, destination);
									} finally {
										await unlink(temporary).catch(() => {});
									}
									this.state.downloaded++;
								}
								this.sources.set(path, { hash, size });
							}
							this.state.completed++;
							if (this.state.completed % 100 === 0) this.publish();
						} catch (error) {
							failure = error;
						}
					}
				})
			);
			if (failure) throw failure;
			// The shell is not part of the public manifest; fetch it inside the same version window.
			this.shell = await this.fetchBytes("", 8 * 1024 * 1024);
			if (!/<(?:html[\s>]|!doctype\s+html[\s>])/i.test(this.shell.toString())) throw new Error("游戏启动页面无效");
			if ((await this.remoteVersion()) !== version) throw new Error("更新期间服务器版本发生变化，请重新启动完成更新");
			this.state.phase = "ready";
			this.publish();
		} catch (error) {
			this.state.phase = "failed";
			this.publish();
			await this.close();
			throw new Error(`强制更新未完成，拒绝启动：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	assertReady() {
		if (this.state.phase !== "ready") throw new Error("强制更新未完成，拒绝开始或操作游戏");
	}
	async read(url: string): Promise<Buffer | undefined> {
		this.assertReady();
		const parsed = new URL(url);
		if (parsed.origin !== this.base.origin || !parsed.pathname.startsWith(this.base.pathname)) return undefined;
		const path = "/" + parsed.pathname.slice(this.base.pathname.length);
		if (path === "/" || path === "/index.html") return this.shell;
		if (path === "/version") return Buffer.from(this.state.version!);
		if (path === "/cache-manifest.json") return Buffer.from(this.manifestText);
		const source = this.sources.get(path);
		if (!source) return undefined;
		try {
			const bytes =
				source.entry && this.file
					? await readRange(this.file, source.entry.offset, source.entry.size)
					: await readFile(join(this.options.cache, source.hash));
			verify(bytes, source.hash, source.size);
			return bytes;
		} catch {
			this.state.phase = "failed";
			this.publish();
			throw new Error("已验证资源发生变化，拒绝继续游戏");
		}
	}
	async close() {
		this.abort.abort();
		if (this.state.phase === "ready") this.state.phase = "failed";
		await this.file?.close();
		this.file = undefined;
	}
}
