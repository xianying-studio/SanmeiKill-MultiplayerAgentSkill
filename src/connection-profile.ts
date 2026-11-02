import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ConnectionSettings {
	server: string;
	room: string;
	reconnect: [string, string | null, string?];
	storage: Record<string, string>;
}
export class ConnectionProfile {
	private previous = "";
	private writing: Promise<void> = Promise.resolve();
	constructor(
		readonly directory: string,
		readonly site: string
	) {}
	async load(): Promise<ConnectionSettings | undefined> {
		let text: string;
		try {
			text = await readFile(join(this.directory, "connection.json"), "utf8");
		} catch (error: any) {
			if (error.code === "ENOENT") return undefined;
			throw error;
		}
		try {
			if (text.length > 65536) throw new Error();
			const data = JSON.parse(text);
			if (data.version !== 1 || data.site !== this.site) return undefined;
			if (
				typeof data.server !== "string" ||
				!["ws:", "wss:"].includes(new URL(data.server).protocol) ||
				typeof data.room !== "string" ||
				!Array.isArray(data.reconnect) ||
				data.reconnect.length < 2 ||
				data.reconnect.length > 3 ||
				typeof data.reconnect[0] !== "string" ||
				!(typeof data.reconnect[1] === "string" || data.reconnect[1] === null) ||
				!(data.reconnect[2] === undefined || typeof data.reconnect[2] === "string") ||
				!data.storage ||
				Object.entries(data.storage).some(([key, value]) => !key.endsWith("_key") || typeof value !== "string")
			)
				throw new Error();
			this.previous = text;
			return data;
		} catch {
			throw new Error("会话重连资料损坏，请使用新的 --session；不要猜测或修改玩家席位");
		}
	}
	async save(settings: ConnectionSettings) {
		const text = JSON.stringify({ version: 1, site: this.site, ...settings });
		const write = this.writing
			.catch(() => {})
			.then(async () => {
				// Earlier queued writes may change the disk value before this request runs.
				if (text === this.previous) return;
				await mkdir(this.directory, { recursive: true, mode: 0o700 });
				const temporary = join(this.directory, `connection.${randomUUID()}.tmp`);
				await writeFile(temporary, text, { mode: 0o600 });
				await rename(temporary, join(this.directory, "connection.json"));
				this.previous = text;
			});
		this.writing = write;
		return write;
	}
}
