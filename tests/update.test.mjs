import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceUpdater } from "../dist/update.js";
import { PlayerClient } from "../dist/client.js";
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifest = (files) => ({
	schema: 2,
	algorithm: "sha256",
	count: Object.keys(files).length,
	files: Object.keys(files),
	hashes: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, hash(b)])),
	sizes: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, Buffer.byteLength(b)])),
});
async function pack(path, files) {
	const entries = Object.entries({ "/index.html": "<html>old</html>", ...files }).map(([path, body]) => ({
		path,
		size: Buffer.byteLength(body),
		hash: hash(body),
		type: "text/javascript",
	}));
	const metadata = Buffer.from(JSON.stringify({ format: 1, app: "SanmeiKill", version: "1", manifest: JSON.stringify(manifest(files)), entries }));
	const header = Buffer.alloc(44);
	header.write("SMKPACK1");
	header.writeUInt32BE(metadata.length, 8);
	Buffer.from(hash(metadata), "hex").copy(header, 12);
	await writeFile(
		path,
		Buffer.concat([header, metadata, ...Object.values({ "/index.html": "<html>old</html>", ...files }).map((x) => Buffer.from(x))])
	);
}
async function fixture(t, { files = { "/a.js": "new" }, local, corrupt, flip = false, unavailable = false } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "sanmei-update-"));
	const hits = [];
	let versions = 0;
	const server = createServer((req, res) => {
		hits.push(req.url);
		const path = req.url.replace(/^\/game/, "");
		if (path === "/version") {
			res.writeHead(unavailable ? 503 : 200);
			res.end(flip && ++versions > 1 ? "3" : "2");
		} else if (path === "/cache-manifest.json") res.end(JSON.stringify(manifest(files)));
		else if (path === "/index.html" || path === "/") res.end("<html>current</html>");
		else if (path in files) res.end(corrupt ? "bad" : files[path]);
		else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const site = `http://127.0.0.1:${server.address().port}/game/`;
	const packagePath = local ? join(dir, "game.smk") : undefined;
	if (local) await pack(packagePath, local);
	const updater = new ResourceUpdater({ site, package: packagePath, cache: join(dir, "cache") });
	t.after(async () => {
		await updater.close();
		await new Promise((resolve) => server.close(resolve));
		await rm(dir, { recursive: true, force: true });
	});
	return { updater, hits, dir, site, packagePath };
}
test("本地优先：只下载改变的文件，全部校验后才 ready", async (t) => {
	const { updater, hits, site } = await fixture(t, { files: { "/a.js": "same", "/b.js": "new" }, local: { "/a.js": "same", "/b.js": "old" } });
	assert.throws(() => updater.assertReady());
	await updater.prepare();
	assert.equal(updater.state.phase, "ready");
	assert.equal(updater.state.reused, 1);
	assert.equal(updater.state.downloaded, 1);
	assert.ok(!hits.includes("/game/a.js"));
	assert.ok(hits.includes("/game/b.js"));
	assert.equal((await updater.read(site + "b.js")).toString(), "new");
});
test("无包体下载静态资源；下次仍检查远端版本但复用已校验缓存", async (t) => {
	const { updater, hits, site, dir } = await fixture(t);
	await updater.prepare();
	hits.length = 0;
	const next = new ResourceUpdater({ site, cache: join(dir, "cache") });
	t.after(() => next.close());
	await next.prepare();
	assert.equal(next.state.downloaded, 0);
	assert.equal(hits.filter((p) => p.endsWith("version")).length, 2);
	assert.ok(!hits.includes("/game/a.js"));
});
for (const [name, options] of [
	["版本服务不可用", { unavailable: true, local: { "/a.js": "new" } }],
	["更新文件损坏", { corrupt: true }],
	["更新途中换版", { flip: true }],
])
	test(`${name}时拒绝启动`, async (t) => {
		const { updater } = await fixture(t, options);
		await assert.rejects(updater.prepare(), /拒绝启动/);
		assert.equal(updater.state.phase, "failed");
		assert.throws(() => updater.assertReady());
	});
test("损坏本地匹配资源不能绕过校验", async (t) => {
	const { updater, packagePath } = await fixture(t, { local: { "/a.js": "new" } });
	const bytes = await readFile(packagePath);
	bytes[bytes.length - 1] ^= 1;
	await writeFile(packagePath, bytes);
	await assert.rejects(updater.prepare(), /完整性校验失败/);
});
test("未完成更新时所有对局入口拒绝，不访问页面", async () => {
	const client = new PlayerClient({ site: "https://example.test/", profile: "/tmp/unused" });
	client.phase = "joined";
	for (const call of [
		() => client.join("x", 1),
		() => client.joinInvitation("x"),
		() => client.act("x", 1),
		() => client.say("你好"),
		() => client.describe("秋鹊"),
	])
		await assert.rejects(call(), /强制更新未完成/);
});

test("更新失败发生在浏览器启动之前", async (t) => {
	const { site, dir } = await fixture(t, { unavailable: true });
	const client = new PlayerClient({ site, profile: join(dir, "profile") });
	await assert.rejects(client.start(), /强制更新未完成/);
	assert.equal(client.context, undefined);
	assert.equal(client.updater.state.phase, "failed");
});
test("更新完成后缓存被修改，立即撤销可用状态", async (t) => {
	const { updater, dir, site } = await fixture(t);
	await updater.prepare();
	await writeFile(join(dir, "cache", hash("new")), "tampered");
	await assert.rejects(updater.read(site + "a.js"), /拒绝继续/);
	assert.throws(() => updater.assertReady());
});
test("损坏的增量缓存必须重新下载，不能因版本相同而跳过", async (t) => {
	const { updater, dir } = await fixture(t);
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(dir, "cache"));
	await writeFile(join(dir, "cache", hash("new")), "bad");
	await updater.prepare();
	assert.equal(updater.state.downloaded, 1);
	assert.equal((await readFile(join(dir, "cache", hash("new")))).toString(), "new");
});
