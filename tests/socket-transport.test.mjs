import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { SocketTransport } from "../dist/socket-transport.js";
import { NodeRuntime } from "../dist/node-runtime.js";

test("游戏线程忙碌时仍及时回复心跳，保留普通消息与关闭原因", { timeout: 15000 }, async (t) => {
	const server = new Worker(new URL("./fixtures/heartbeat-server.mjs", import.meta.url));
	t.after(() => server.terminate());
	const [ready] = await once(server, "message");
	const socket = new SocketTransport(ready.url);
	t.after(() => socket.dispose());
	await once(socket, "open");
	const messages = [];
	socket.on("message", (data) => messages.push(data.toString()));
	const echoed = once(socket, "message");
	socket.send("玩家操作");
	assert.equal((await echoed)[0], "玩家操作");
	const started = once(server, "message");
	server.postMessage("start");
	await started;
	// A separate server thread enforces its deadline while the game thread cannot run callbacks.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
	const reportReady = once(server, "message");
	server.postMessage("report");
	const [report] = await reportReady;
	assert.equal(report.missed, false);
	assert.ok(report.replies >= 2);
	assert.deepEqual(messages, ["玩家操作"]);
	const closed = once(socket, "close");
	server.postMessage("close");
	assert.deepEqual(await closed, [4001, "测试结束"]);
	assert.equal(socket.readyState, 3);
	assert.throws(() => socket.send("过期操作"), /未就绪/);
});

test("主动替换旧连接不误报断线，实际连接关闭仍报告关闭原因", { timeout: 15000 }, async (t) => {
	const server = new Worker(new URL("./fixtures/heartbeat-server.mjs", import.meta.url));
	t.after(() => server.terminate());
	const [ready] = await once(server, "message");
	const disconnected = [];
	const runtime = new NodeRuntime(
		{
			base: new URL("https://game.test/"),
			assertReady() {},
			async read() {
				return Buffer.from("<html><body></body></html>");
			},
		},
		{ onEvent() {}, onDisconnect: (details) => disconnected.push(details) }
	);
	t.after(() => runtime.close());
	await runtime.goto("https://game.test/");
	const event = (socket, name) => new Promise((resolve) => socket.addEventListener(name, resolve, { once: true }));
	const old = new runtime.window.WebSocket(ready.url);
	await event(old, "open");
	const current = new runtime.window.WebSocket(ready.url);
	await event(current, "open");
	const oldClosed = event(old, "close");
	old._nocallback = true;
	old.close(1000);
	await oldClosed;
	assert.deepEqual(disconnected, []);
	const currentClosed = event(current, "close");
	server.postMessage("close");
	await currentClosed;
	assert.deepEqual(disconnected, [{ code: 4001, reason: "测试结束" }]);
});
