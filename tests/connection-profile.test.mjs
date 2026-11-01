import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { ConnectionProfile } from "../dist/connection-profile.js";
import { NodeRuntime } from "../dist/node-runtime.js";

test("仅保存自己的重连资料，按站点、服务器与邀请房间恢复；资料不进入公开事件", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "sanmei-profile-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const events = [];
	const runtime = new NodeRuntime({}, { onEvent: (...args) => events.push(args), onDisconnect() {} });
	runtime.window = new Window();
	t.after(() => runtime.window.happyDOM.close());
	runtime.window.localStorage.setItem("noname_0.9_key", "自己的连接凭据");
	runtime.window.localStorage.setItem("unrelated", "不保存的数据");
	runtime.profile = new ConnectionProfile(directory, "https://game.test/");
	runtime.activeServer = "wss://server.test/";
	runtime.publicModule =
		"data:text/javascript," +
		encodeURIComponent(
			'export const lib={config:{reconnect_info:["wss://server.test:443","自己的席位",null,"隐藏内容"]},hiddenHand:"隐藏内容"};export const game={roomId:"123",onlineID:"自己的席位"};'
		);
	await runtime.saveConnection();
	const text = await readFile(join(directory, "connection.json"), "utf8");
	assert.ok(!text.includes("隐藏内容") && !text.includes("不保存的数据"));
	assert.equal((await stat(join(directory, "connection.json"))).mode & 0o777, 0o600);
	assert.equal(await new ConnectionProfile(directory, "https://other.test/").load(), undefined);
	runtime.connectionSettings = await new ConnectionProfile(directory, "https://game.test/").load();
	const { lib } = await import(runtime.publicModule);
	lib.config.reconnect_info = null;
	await runtime.restoreConnection("wss://other.test/", "123");
	assert.equal(lib.config.reconnect_info, null);
	await runtime.restoreConnection("wss://server.test/", "456");
	assert.equal(lib.config.reconnect_info, null);
	await runtime.restoreConnection("wss://server.test/");
	assert.equal(lib.config.reconnect_info, null);
	await runtime.restoreConnection("wss://server.test/", "123");
	assert.deepEqual(lib.config.reconnect_info, ["wss://server.test/", "自己的席位"]);
	assert.deepEqual(events, []);
});

test("损坏的重连资料明确报错，不静默换成新身份", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "sanmei-profile-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "connection.json"), "{");
	await assert.rejects(new ConnectionProfile(directory, "https://game.test/").load(), /重连资料损坏/);
});

test("重连资料写入失败只警告一次，仍能继续刷新对局", async (t) => {
	const events = [];
	const runtime = new NodeRuntime({}, { onEvent: (...args) => events.push(args), onDisconnect() {} });
	runtime.window = new Window();
	t.after(() => runtime.window.happyDOM.close());
	runtime.publicModule =
		"data:text/javascript," +
		encodeURIComponent(
			'export const lib={config:{reconnect_info:["wss://server.test/","席位"]}};export const game={roomId:"123",onlineID:"席位"};'
		);
	runtime.activeServer = "wss://server.test/";
	runtime.profile = {
		async save() {
			throw Error("disk full");
		},
	};
	await runtime.saveConnection();
	await runtime.saveConnection();
	assert.equal(events.length, 1);
	assert.equal(events[0][0], "warning");
});
