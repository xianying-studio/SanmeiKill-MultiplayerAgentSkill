import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { readPublicDetails } from "../dist/public-details.js";
import { diffSnapshots } from "../dist/diff.js";
import { Journal } from "../dist/events.js";

test("只读取公开身份和实际简介，包含失效技能、标记及计数器，绝不读取隐藏字段", async () => {
	const window = new Window();
	window.document.body.innerHTML =
		'<div class="player" data-player-client-id="v1"><div class="identity guessing">忠</div><div class="marks"><div class="mark">星<div class="markcount">2</div></div></div><div class="tipContainer"><div class="tip">永久手牌上限 +1</div></div></div>';
	const player = window.document.querySelector(".player");
	Object.defineProperty(player, "identity", {
		get() {
			throw Error("禁止读取隐藏身份");
		},
	});
	Object.defineProperty(player, "skills", {
		get() {
			throw Error("禁止读取内部技能列表");
		},
	});
	const api = {
		poptipName: () => "〖星合〗",
		intro(node) {
			const tooltip = window.document.createElement("div");
			tooltip.innerHTML =
				node === player
					? '<div style="opacity:0.5"><div class="skill">技能甲</div><div>公开动态描述<sanmei-kill-poptip poptip="skill"></sanmei-kill-poptip><div class="infohidden">隐藏技能</div></div></div>'
					: node.classList.contains("mark")
						? '<div class="caption">星流</div><div>当前拥有2个“星”标记</div>'
						: "";
			return tooltip;
		},
	};
	let details = readPublicDetails(window, [{ id: "v1" }], api, () => true).v1;
	assert.equal(details.identity, null);
	assert.deepEqual(details.skills, [{ name: "技能甲", description: "公开动态描述〖星合〗", disabled: true }]);
	assert.match(details.indicators[0].description, /当前拥有2个/);
	assert.equal(details.indicators[1].text, "永久手牌上限 +1");
	assert.ok(!JSON.stringify(details).includes("隐藏技能"));
	player.querySelector(".identity").classList.remove("guessing");
	details = readPublicDetails(window, [{ id: "v1" }], api, () => true).v1;
	assert.equal(details.identity, "忠");
	await window.happyDOM.close();
});

test("状态差量可完整重建，单个计数变化不重复所有技能描述", () => {
	const before = {
		details: { v1: { skills: [{ name: "甲", description: "很长的公开技能描述".repeat(100) }], indicators: [{ name: "星", text: "1" }] } },
		actions: [{ id: "v2" }],
	};
	const after = structuredClone(before);
	after.details.v1.indicators[0].text = "2";
	after.actions = [];
	const patch = diffSnapshots(before, after);
	assert.ok(!JSON.stringify(patch).includes("很长的公开技能描述"));
	const rebuilt = structuredClone(before);
	for (const op of patch) {
		const keys = op.path
			.slice(1)
			.split("/")
			.map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
		const key = keys.pop();
		let parent = rebuilt;
		for (const k of keys) parent = parent[k];
		if (op.op === "remove") delete parent[key];
		else parent[key] = op.value;
	}
	assert.deepEqual(rebuilt, after);
	assert.deepEqual(diffSnapshots(after, after), []);
});

test("事件分页保持连续游标，防止一次输出整场历史", () => {
	const journal = new Journal();
	for (let i = 0; i < 250; i++) journal.append("log", { text: String(i) });
	const first = journal.read(0);
	assert.equal(first.events.length, 100);
	assert.equal(first.cursor, 100);
	assert.equal(first.hasMore, true);
	const second = journal.read(first.cursor),
		third = journal.read(second.cursor);
	assert.equal(third.events.length, 50);
	assert.equal(third.cursor, 250);
	assert.equal(third.hasMore, false);
	assert.equal(journal.cursor, 250);
});
