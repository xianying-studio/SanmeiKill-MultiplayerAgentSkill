import type { MessagePort } from "node:worker_threads";
let port: MessagePort;
let base: string;
let imports: Record<string, string>;
let sequence = 0;
const pending = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
export function initialize(data: { port: MessagePort; base: string; imports: Record<string, string> }) {
	({ port, base, imports } = data);
	port.on("message", (message) => {
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error) request.reject(new Error("已校验游戏模块加载失败"));
		else request.resolve(message.source);
	});
}
export async function resolve(specifier: string, context: any, next: any) {
	if (context.parentURL?.startsWith(base) || specifier.startsWith(base)) {
		const target = imports[specifier] ?? specifier;
		if (!/^(https?:|\/|\.)/.test(target)) throw new Error("游戏模块包含不支持的导入");
		const url = new URL(target, context.parentURL ?? base);
		if (!url.href.startsWith(base)) throw new Error("禁止加载游戏站点之外的模块");
		return { url: url.href, shortCircuit: true };
	}
	return next(specifier, context);
}
export async function load(url: string, context: any, next: any) {
	if (!url.startsWith(base)) return next(url, context);
	const id = ++sequence;
	const source = await new Promise<string>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		port.postMessage({ id, url });
	});
	return { format: "module", source, shortCircuit: true };
}
