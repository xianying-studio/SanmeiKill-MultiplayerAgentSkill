import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { SocketTransport } from "../dist/socket-transport.js";
import { NodeRuntime } from "../dist/node-runtime.js";
import { WebSocketServer } from "ws";

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

test("停止传输时先发送已排队消息和关闭帧，不把正常停止变成异常断线", { timeout: 15000 }, async (t) => {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	t.after(() => new Promise((resolve) => server.close(resolve)));
	await once(server, "listening");
	const connected = once(server, "connection");
	const socket = new SocketTransport(`ws://127.0.0.1:${server.address().port}`);
	t.after(() => socket.dispose());
	const [peer] = await connected;
	const received = [];
	peer.on("message", (data) => received.push(data.toString()));
	await once(socket, "open");
	const peerClosed = once(peer, "close");
	socket.send("停止前已提交的操作");
	socket.close(1000, "正常停止");
	await socket.dispose();
	const [code, reason] = await peerClosed;
	assert.equal(code, 1000);
	assert.equal(reason.toString(), "正常停止");
	assert.deepEqual(received, ["停止前已提交的操作"]);
	assert.equal(socket.readyState, 3);
});

test("对端不回应关闭握手时仍能限时清理，重复清理共享同一任务", { timeout: 6000 }, async (t) => {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	let peer, socket;
	t.after(async () => {
		peer?.terminate();
		await socket?.dispose();
		await new Promise((resolve) => server.close(resolve));
	});
	await once(server, "listening");
	const connected = once(server, "connection");
	socket = new SocketTransport(`ws://127.0.0.1:${server.address().port}`);
	[peer] = await connected;
	await once(socket, "open");
	peer.pause();
	const cleanup = socket.dispose();
	assert.equal(socket.dispose(), cleanup);
	await cleanup;
	assert.equal(socket.readyState, 3);
});
