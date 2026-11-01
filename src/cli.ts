#!/usr/bin/env node
import { parseInvitation } from "./invite.js";
import { defaultGameSite, resourceSource, checkLocalPackage } from "./resources.js";
import { parseArgs } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PlayerClient, playerNickname, type Options } from "./client.js";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		help: { type: "boolean", short: "h" },
		session: { type: "string", default: ".sessions/default.json" },
		site: { type: "string", default: defaultGameSite },
		invite: { type: "string" },
		"invite-file": { type: "string" },
		server: { type: "string" },
		package: { type: "string" },
		id: { type: "string" },
		revision: { type: "string" },
		after: { type: "string", default: "0" },
		timeout: { type: "string", default: "25000" },
		text: { type: "string" },
		name: { type: "string" },
		nickname: { type: "string" },
	},
});
const command = values.help ? "help" : (positionals[0] ?? "help");
const session = resolve(values.session!);
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Session {
	port: number;
	token: string;
	pid: number;
}
async function request(action: string, args: unknown = {}) {
	const config = JSON.parse(await readFile(session, "utf8")) as Session;
	const response = await fetch(`http://127.0.0.1:${config.port}/${action}`, {
		method: "POST",
		headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
		body: JSON.stringify(args),
		signal: AbortSignal.timeout(65000),
	});
	const result = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(result.error ?? "客户端请求失败");
	return result;
}
async function daemon() {
	const token = randomBytes(32).toString("hex");
	const options: Options = {
		site: values.site!,
		server: values.server,
		package: values.package ? resolve(values.package) : undefined,
		invite: values.invite,
		nickname: values.nickname,
		profile: session + ".profile",
	};
	const client = new PlayerClient(options);
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		await client.close();
		server.close();
		await rm(session, { force: true });
		await rm(session + ".lock", { force: true });
		process.exit(0);
	};
	const server = createServer(async (req, res) => {
		const auth = Buffer.from(req.headers.authorization ?? "");
		const expected = Buffer.from(`Bearer ${token}`);
		if (req.headers.origin || req.method !== "POST" || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
			res.writeHead(403);
			res.end();
			return;
		}
		try {
			let body = "";
			for await (const chunk of req) {
				body += chunk;
				if (body.length > 8192) throw new Error("请求过大");
			}
			const args = JSON.parse(body || "{}");
			let result: unknown;
			if (req.url === "/status" || req.url === "/rooms") result = client.status();
			else if (req.url === "/events") result = client.journal.read(args.after ?? 0);
			else if (req.url === "/wait") {
				const timeout = Math.min(55000, Math.max(0, Number(args.timeout ?? 25000)));
				if (!Number.isFinite(timeout)) throw new Error("等待时间无效");
				const deadline = Date.now() + timeout;
				let events = client.journal.read(args.after ?? 0);
				while (!events.events.length && Date.now() < deadline && !stopping) {
					await delay(100);
					events = client.journal.read(args.after ?? 0);
				}
				result = { ...events, status: client.summary() };
			} else if (req.url === "/join") result = await client.run(() => client.join(args.id, args.revision));
			else if (req.url === "/join-invite") result = await client.run(() => client.joinInvitation(args.invite));
			else if (req.url === "/act" || req.url === "/autoplay")
				result = await client.run(async () => {
					const cursor = client.journal.cursor;
					if (req.url === "/act") await client.act(args.id, args.revision);
					else await client.autoplay(args.enabled);
					return { status: client.summary(), ...client.journal.read(cursor) };
				});
			else if (req.url === "/say") result = await client.run(() => client.say(args.text));
			else if (req.url === "/describe") result = await client.run(() => client.describe(args.name));
			else if (req.url === "/stop") {
				result = { stopped: true };
				setTimeout(() => void stop(), 100);
			} else throw new Error("未知命令");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(result));
		} catch (error) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("本地客户端监听失败");
	await writeFile(session, JSON.stringify({ port: address.port, token, pid: process.pid }), { mode: 0o600 });
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
	client.start().catch((error) => {
		client.phase = "error";
		client.journal.append("error", { message: error.message });
	});
}
async function main() {
	if (values["invite-file"]) values.invite = await readFile(resolve(values["invite-file"]), "utf8");
	if (values.invite) {
		const invitation = parseInvitation(values.invite);
		if (values.server && new URL(values.server).href !== invitation.server) throw new Error("--server 与邀请地址冲突");
		values.server = invitation.server;
	}
	if (command === "parse-invite") return print(parseInvitation(values.invite ?? ""));
	if (command === "serve") return daemon();
	if (command === "start") {
		values.nickname = playerNickname(values.nickname);
		values.site = resourceSource(values.site, values.package).site;
		await checkLocalPackage(values.package);
		await mkdir(dirname(session), { recursive: true, mode: 0o700 });
		const lock = await open(session + ".lock", "wx", 0o600).catch(() => {
			throw new Error("此会话已启动；请先 status/stop，异常退出后确认旧进程已结束再移除 .lock");
		});
		await lock.close();
		const args = [fileURLToPath(import.meta.url), "serve", "--session", session, "--site", values.site!];
		if (values.server) args.push("--server", values.server);
		if (values.package) args.push("--package", resolve(values.package));
		if (values.invite) args.push("--invite", values.invite);
		args.push("--nickname", values.nickname);
		const log = await open(session + ".log", "a", 0o600);
		const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", log.fd, log.fd] });
		child.unref();
		await log.close();
		for (let n = 0; n < 100; n++) {
			await delay(100);
			try {
				return print(await request("status"));
			} catch {
				/* Wait for local daemon readiness only. */
			}
		}
		throw new Error(`启动失败，请检查 ${session}.log；不要重复启动`);
	}
	if (command === "help")
		return print({
			commands: [
				"start [--site https://…] [--package game.smk] [--server wss://…] [--nickname AI名字]",
				"status",
				"rooms",
				"join --id v1 --revision 2",
				"join-invite --invite-file invitation.txt",
				"wait --after 0 --timeout 25000",
				"events --after 0",
				"act --id v2 --revision 3",
				"describe --name 秋鹊",
				"say --text 简短的公开操作点评",
				"autoplay on|off",
				"parse-invite --invite-file invitation.txt",
				"stop",
			],
			session: "使用 --session <文件> 区分多个 AI 玩家。只加入已有房间，不提供创建或开始游戏命令。",
			resources: {
				defaultSite: defaultGameSite,
				policy: "未传 --package 时从游戏网站加载静态资源；--site 指定游戏地址，--server 指定联机地址。本地包体作为基底，启动前必须联网完成强制更新；更新失败拒绝启动。",
			},
		});
	if (!["status", "rooms", "join", "join-invite", "wait", "events", "act", "describe", "say", "autoplay", "stop"].includes(command))
		throw new Error("未知命令，运行 help 查看支持的操作");
	if (command === "autoplay" && !["on", "off"].includes(positionals[1])) throw new Error("使用 autoplay on 或 autoplay off");
	const result = await request(command, {
		id: values.id,
		revision: Number(values.revision),
		after: Number(values.after),
		timeout: Number(values.timeout),
		name: values.name,
		text: values.text,
		invite: values.invite,
		enabled: positionals[1] === "on",
	});
	print(result);
}
main().catch((error) => {
	print({ error: error.message });
	process.exitCode = 1;
});
