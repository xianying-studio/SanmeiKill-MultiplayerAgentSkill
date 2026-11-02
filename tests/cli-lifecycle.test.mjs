import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, access, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("stop 返回时旧锁已释放，可立即以相同会话再次 start", { timeout: 20000 }, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "sanmei-cli-stop-"));
	const session = join(directory, "player.json");
	const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
	const run = async (...args) =>
		JSON.parse((await promisify(execFile)(process.execPath, [cli, ...args, "--session", session], { timeout: 12000 })).stdout);
	const server = createServer((_req, res) => {
		res.writeHead(503);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		try {
			await run("stop");
		} catch {
			try {
				process.kill(JSON.parse(await readFile(session, "utf8")).pid, "SIGTERM");
			} catch {}
		}
		await new Promise((resolve) => server.close(resolve));
		await rm(directory, { recursive: true, force: true });
	});
	const site = `http://127.0.0.1:${server.address().port}/`;
	for (let i = 0; i < 2; i++) {
		await run("start", "--site", site);
		assert.deepEqual(await run("stop"), { stopped: true });
		await assert.rejects(access(session + ".lock"));
		await assert.rejects(access(session));
	}
});
