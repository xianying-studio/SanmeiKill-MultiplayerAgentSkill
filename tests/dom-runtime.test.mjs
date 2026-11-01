import test from "node:test";
import assert from "node:assert/strict";
import { Window, PropertySymbol } from "happy-dom";
import { bindEventProperties, pruneDomCaches } from "../dist/node-runtime.js";

test("WebSocket 风格回调只触发一次，this 正确绑定以回复心跳", async () => {
	const window = new Window();
	class Socket extends window.EventTarget {
		constructor() {
			super();
			bindEventProperties(this, ["message", "close"]);
		}
		sent = [];
		send(value) {
			this.sent.push(value);
		}
	}
	const socket = new Socket();
	let calls = 0;
	socket.onmessage = function (event) {
		calls++;
		assert.equal(this, socket);
		this.send(event.data);
	};
	socket.dispatchEvent(new window.MessageEvent("message", { data: "heartbeat" }));
	assert.equal(calls, 1);
	assert.deepEqual(socket.sent, ["heartbeat"]);
	socket.onmessage = null;
	socket.dispatchEvent(new window.MessageEvent("message", { data: "ignored" }));
	assert.equal(calls, 1);
	await window.happyDOM.close();
});

test("长期样式变化的依赖缓存有界，清理后可见性与选择器仍正确", async () => {
	const window = new Window();
	window.document.head.innerHTML = "<style>.hidden { display:none } .active { color:red }</style>";
	window.document.body.innerHTML = '<div id="arena"><div class="player"><span>玩家</span></div></div>';
	const player = window.document.querySelector(".player");
	let pruned = 0;
	for (let i = 0; i < 500; i++) {
		player.classList.toggle("hidden", i % 2 === 0);
		assert.equal(window.getComputedStyle(player).display === "none", i % 2 === 0);
		window.getComputedStyle(player.firstElementChild).color;
		assert.equal(window.document.querySelectorAll(".player").length, 1);
		if (pruneDomCaches(window, 64)) pruned++;
		assert.ok(window.document[PropertySymbol.affectsComputedStyleCache].length < 64);
		assert.ok(window.document.documentElement[PropertySymbol.affectsCache].length < 64);
	}
	assert.ok(pruned > 0);
	await window.happyDOM.close();
});

test("公开视图选择器不会无限保留文档级依赖缓存", async () => {
	const window = new Window();
	window.document.body.innerHTML = '<div class="player">玩家</div>';
	const player = window.document.querySelector(".player");
	let pruned = 0;
	for (let i = 0; i < 2000; i++) {
		assert.equal(player.matches(`.player[data-test="${i}"]`), false);
		if (pruneDomCaches(window, 64)) pruned++;
		assert.ok(window.document[PropertySymbol.affectsCache].length < 64);
	}
	assert.ok(pruned > 0);
	assert.equal(window.document.querySelector(".player").textContent, "玩家");
	await window.happyDOM.close();
});

test("关闭聊天面板仍增量接收发送者与公开消息，不重复、不暴露其他引擎字段", async () => {
	const { NodeRuntime } = await import("../dist/node-runtime.js");
	const runtime = new NodeRuntime({}, { onEvent() {}, onDisconnect() {} });
	runtime.window = new Window();
	runtime.window.document.body.innerHTML = '<div id="system"></div>';
	runtime.publicModule =
		"data:text/javascript," +
		encodeURIComponent(
			'export const lib={chatHistory:[["甲[玩家甲]","你好"]],secretHand:"绝不输出"}; export const ui={sidebar:{children:[{innerHTML:"甲进入了弃牌阶段"}]}};'
		);
	const first = await runtime.readPublicEvents();
	assert.deepEqual(first, [
		{ type: "log", text: "甲进入了弃牌阶段" },
		{ type: "chat", sender: "甲[玩家甲]", text: "你好" },
	]);
	assert.deepEqual(await runtime.readPublicEvents(), []);
	const { lib } = await import(runtime.publicModule);
	lib.chatHistory.push(["乙", "<b>第二条</b>"]);
	assert.deepEqual(await runtime.readPublicEvents(), [{ type: "chat", sender: "乙", text: "第二条" }]);
	assert.ok(!JSON.stringify(first).includes("绝不输出"));
	await runtime.window.happyDOM.close();
});

test("邀请按公开房间容器的房间号精确加入，不误点其他房间", async () => {
	const { NodeRuntime } = await import("../dist/node-runtime.js");
	const runtime = new NodeRuntime({ assertReady() {} }, { onEvent() {}, onDisconnect() {} });
	runtime.window = new Window();
	runtime.window.document.body.innerHTML =
		'<div class="dialog"><div class="caption"><div class="popup text pointerdiv">甲的房间</div></div><div class="caption"><div class="popup text pointerdiv">乙的房间</div></div></div>';
	const captions = runtime.window.document.querySelectorAll(".caption");
	let joined = "";
	for (const [i, node] of [...captions].entries()) {
		node.key = String(i + 100);
		node.addEventListener("click", () => {
			joined = node.key;
		});
	}
	await runtime.joinPublicRoom("101");
	assert.equal(joined, "101");
	await assert.rejects(runtime.joinPublicRoom("999"));
	assert.equal(joined, "101");
	await runtime.window.happyDOM.close();
});
