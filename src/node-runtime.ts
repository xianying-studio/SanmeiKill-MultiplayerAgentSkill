import { SocketTransport } from "./socket-transport.js";
import { Window, PropertySymbol } from "happy-dom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { register } from "node:module";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { DomLocator } from "./dom-page.js";
import { installView } from "./view.js";
import { readPublicDetails } from "./public-details.js";
import { ConnectionProfile, type ConnectionSettings } from "./connection-profile.js";
import type { ResourceUpdater } from "./update.js";

export function bindEventProperties(target: any, names: string[]) {
	for (const name of names) {
		let handler: unknown = null;
		Object.defineProperty(target, "on" + name, {
			configurable: true,
			get: () => handler,
			set: (value) => {
				handler = typeof value === "function" ? value.bind(target) : null;
			},
		});
	}
}
const NativeWebSocket = globalThis.WebSocket;
const nativeFetch = globalThis.fetch;

// Happy DOM 21 retains invalidated cache dependency entries on long-lived ancestors.
// Bound those dependency lists without changing DOM, game state, or CSS semantics.
export function pruneDomCaches(window: any, threshold = 20000) {
	const document = window.document;
	if (
		document[PropertySymbol.affectsCache].length < threshold &&
		document[PropertySymbol.affectsComputedStyleCache].length < threshold &&
		(document.documentElement?.[PropertySymbol.affectsCache].length ?? 0) < threshold
	)
		return false;
	document[PropertySymbol.clearComputedStyleCache]();
	const visit = (node: any) => {
		node[PropertySymbol.clearCache]();
		for (const child of node.childNodes) visit(child);
		if (node.shadowRoot) visit(node.shadowRoot);
	};
	visit(document);
	return true;
}
export class NodeRuntime extends EventEmitter {
	window: any;
	private closed = false;
	private failure?: Error;
	private port?: MessagePort;
	private sockets = new Set<any>();
	private observer?: any;
	private animations = new Set<any>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private loadedScripts = new WeakSet<object>();
	private loadedLinks = new WeakSet<object>();
	private publicModule?: string;
	private chatCursor = 0;
	private seenPublicLogs = new WeakSet<object>();
	private profile?: ConnectionProfile;
	private connectionSettings?: ConnectionSettings;
	private activeServer = "";
	private profileWarning = false;
	readonly mouse = {
		move: async (_x?: number, _y?: number) => {
			for (const node of this.window.document.querySelectorAll("#system div")) node.dispatchEvent(new this.window.MouseEvent("mouseleave"));
		},
	};
	constructor(
		readonly updater: ResourceUpdater,
		readonly options: {
			nickname?: string;
			profile?: string;
			onEvent(type: string, data: unknown): void;
			onDisconnect(details?: { code: number; reason: string }): void;
		}
	) {
		super();
	}
	check() {
		if (this.closed) throw new Error("客户端已关闭");
		if (this.failure) throw this.failure;
		this.updater.assertReady();
	}
	isClosed() {
		return this.closed;
	}
	setDefaultTimeout(_timeout: number) {}
	locator(selector: string) {
		return new DomLocator(this, () => [this.window.document]).locator(selector);
	}
	getByText(text: string, options?: { exact?: boolean }) {
		return new DomLocator(this, () => [this.window.document]).getByText(text, options);
	}
	text(node: any) {
		return (node.textContent ?? "").replace(/\s+/g, " ").trim();
	}
	visible(node: any) {
		if (!node.isConnected) return false;
		for (let current = node; current?.nodeType === 1; current = current.parentElement) {
			const style = this.window.getComputedStyle(current);
			if (
				style.display === "none" ||
				style.visibility === "hidden" ||
				style.visibility === "collapse" ||
				(style.opacity !== "" && Number(style.opacity) === 0)
			)
				return false;
		}
		return true;
	}
	async evaluate<T>(fn: () => T): Promise<T> {
		this.check();
		pruneDomCaches(this.window);
		return this.window.eval(`(${fn.toString()})()`);
	}
	async screenshot(): Promise<Buffer> {
		throw new Error("纯 Node.js 客户端不生成截图，请使用 status 获取玩家可见状态");
	}
	async reload(_options?: unknown) {
		throw new Error("请停止会话后使用 start --invite-file 重新加入；不会重复执行旧操作");
	}
	private fail() {
		this.failure = new Error("玩家运行时加载失败，请检查兼容版本并重新启动");
		this.options.onEvent("error", { message: this.failure.message });
	}
	async goto(site: string, _options?: unknown) {
		this.check();
		const window: any = (this.window = new Window({
			url: site,
			settings: {
				disableCSSFileLoading: true,
				disableJavaScriptFileLoading: true,
				disableComputedStyleRendering: false,
				handleDisabledFileLoadingAsSuccess: true,
			},
		}));
		const html = (await this.updater.read(site))?.toString();
		if (!html) throw new Error("缺少已校验启动页面");
		if (this.options.profile) {
			this.profile = new ConnectionProfile(this.options.profile, site);
			this.connectionSettings = await this.profile.load();
			for (const [key, value] of Object.entries(this.connectionSettings?.storage ?? {})) window.localStorage.setItem(key, value);
		}
		Object.defineProperty(window.navigator, "userAgent", { value: "SanmeiKillHeadless/0.1 Safari/605.1.15", configurable: true });
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open("noname_0.9_data", 4);
			request.onupgradeneeded = () => {
				for (const name of ["config", "data", "audio", "image", "video"])
					if (!request.result.objectStoreNames.contains(name))
						request.result.createObjectStore(name, name === "video" ? { keyPath: "time" } : undefined);
			};
			request.onerror = () => reject(new Error("玩家设置初始化失败"));
			request.onsuccess = () => {
				const db = request.result;
				const transaction = db.transaction("config", "readwrite");
				const store = transaction.objectStore("config");
				for (const [key, value] of Object.entries({
					mode: "connect",
					new_tutorial: true,
					show_splash: "off",
					connect_nickname: this.options.nickname ?? "AI玩家",
					read_clipboard_mode_config_connect: true,
				}))
					store.put(value, key);
				transaction.oncomplete = () => {
					db.close();
					resolve();
				};
				transaction.onerror = () => reject(new Error("玩家设置保存失败"));
			};
		});
		window.document.write(html);
		const imports = JSON.parse(window.document.querySelector('script[type="importmap"]')?.textContent ?? "{}").imports ?? {};
		this.publicModule = imports["sanmei-kill"] ? new URL(imports["sanmei-kill"], site).href : undefined;
		const { port1, port2 } = new MessageChannel();
		this.port = port1;
		port1.on("message", async ({ id, url }) => {
			try {
				const bytes = await this.updater.read(url);
				if (!bytes) throw new Error("missing");
				port1.postMessage({ id, source: bytes.toString() });
			} catch {
				port1.postMessage({ id, error: true });
			}
		});
		port1.unref();
		register(new URL("./module-loader.js", import.meta.url), {
			data: { port: port2, imports, base: this.updater.base.href },
			transferList: [port2],
		});
		(globalThis as any).window = window;
		for (const key of Object.getOwnPropertyNames(window)) {
			if (!(key in globalThis) || ["navigator", "Event", "EventTarget", "CustomEvent", "MouseEvent", "KeyboardEvent"].includes(key)) {
				try {
					Object.defineProperty(globalThis, key, { value: window[key], writable: true, configurable: true });
				} catch {}
			}
		}
		(globalThis as any).document = window.document;
		window.document.execCommand = () => false;
		window.indexedDB = (globalThis as any).indexedDB = indexedDB;
		window.IDBKeyRange = (globalThis as any).IDBKeyRange = IDBKeyRange;
		Object.defineProperty(window.HTMLDivElement.prototype, Symbol.toStringTag, { value: "HTMLDivElement", configurable: true });
		window.Element.prototype.getClientRects = function (this: any) {
			return this.isConnected ? [{ x: 0, y: 0, width: 1440, height: 1000 }] : [];
		};
		window.Element.prototype.getBoundingClientRect = function () {
			return { x: 0, y: 0, left: 0, top: 0, right: 1440, bottom: 1000, width: 1440, height: 1000 };
		};
		const style = window.document.createElement("style");
		style.textContent = "* { visibility: visible; opacity: 1; }";
		window.document.head.prepend(style);
		const noop = () => {};
		const canvas = new Proxy(
			{
				canvas: window.document.createElement("canvas"),
				measureText: () => ({ width: 10 }),
				createLinearGradient: () => ({ addColorStop: noop }),
				createRadialGradient: () => ({ addColorStop: noop }),
				getImageData: () => ({ data: new Uint8ClampedArray(4) }),
			},
			{ get: (object: any, key) => object[key] ?? noop }
		);
		window.HTMLCanvasElement.prototype.getContext = () => canvas;
		const runtime = this;
		window.HTMLElement.prototype.animate = function (this: any, _frames: unknown, options: any = {}) {
			const duration = typeof options === "number" ? options : Number(options.duration) || 0;
			const iterations = options.iterations ?? 1;
			let resolve!: () => void;
			const animation: any = {
				playState: "running",
				effect: { target: this, getTiming: () => ({ duration, iterations }) },
				finished: new Promise<void>((done) => {
					resolve = done;
				}),
				play: noop,
			};
			animation.cancel = () => {
				animation.playState = "finished";
				runtime.animations.delete(animation);
				resolve();
				animation.onfinish?.();
			};
			runtime.animations.add(animation);
			if (iterations !== Infinity) {
				const timer = setTimeout(
					() => {
						runtime.timers.delete(timer);
						animation.cancel();
					},
					duration * iterations + (options.delay ?? 0)
				);
				runtime.timers.add(timer);
			}
			return animation;
		};
		const computedStyle = window.getComputedStyle.bind(window);
		const cssAnimations = new WeakMap<object, { signature: string; animation: any; final: any }>();
		window.getComputedStyle = (node: any) => {
			const computed = computedStyle(node);
			const signature = computed.animation;
			if (!signature || signature === "none" || signature.includes("infinite")) return computed;
			let state = cssAnimations.get(node);
			if (state?.signature !== signature) {
				state?.animation.cancel();
				const rules = Array.from(window.document.styleSheets).flatMap((sheet: any) => Array.from(sheet.cssRules));
				const keyframes: any = rules.find((rule: any) => rule.type === 7 && signature.split(/\s+/).includes(rule.name));
				if (!keyframes) return computed;
				const final: any = Array.from(keyframes.cssRules).find((rule: any) => /^(to|100%)$/.test(rule.keyText));
				const times = [...signature.matchAll(/(?:^|\s)([\d.]+)(ms|s)(?=\s|$)/g)].map(
					(match: any) => Number(match[1]) * (match[2] === "s" ? 1000 : 1)
				);
				const animation = node.animate([], { duration: times[0] ?? 0, delay: times[1] ?? 0 });
				state = { signature, animation, final: /forwards|both/.test(signature) ? final?.style : undefined };
				cssAnimations.set(node, state);
				animation.finished.then(() => node.dispatchEvent(new window.Event("animationend", { bubbles: true })));
			}
			const overrides = state?.animation.playState === "finished" ? state.final : undefined;
			return new Proxy(computed, {
				get(target: any, key: any) {
					if (["opacity", "visibility", "display"].includes(key) && overrides?.[key]) return overrides[key];
					const value = target[key];
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		};
		(globalThis as any).getComputedStyle = window.getComputedStyle;
		window.document.getAnimations = () => [...this.animations];
		(Promise as any).try ??= (fn: any, ...args: any[]) => new Promise((resolve) => resolve(fn(...args)));
		window.alert = (globalThis as any).alert = (text: string) => {
			this.options.onEvent("dialog", { type: "alert", text });
		};
		window.confirm = (globalThis as any).confirm = () => false;
		window.prompt = (globalThis as any).prompt = () => null;
		window.fetch = globalThis.fetch = (async (input: any) => {
			const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, site).href;
			const bytes = await this.updater.read(url);
			return new Response(bytes ? new Uint8Array(bytes) : "", { status: bytes ? 200 : 404 });
		}) as typeof fetch;
		class XHR extends window.EventTarget {
			[key: string]: any;
			constructor() {
				super();
				bindEventProperties(this, ["load", "error", "readystatechange", "loadend"]);
			}
			readyState = 0;
			status = 0;
			responseType = "";
			response: any = null;
			responseText = "";
			open(_method: string, url: string) {
				this.url = url;
				this.readyState = 1;
			}
			setRequestHeader() {}
			overrideMimeType() {}
			getResponseHeader() {
				return null;
			}
			getAllResponseHeaders() {
				return "";
			}
			abort() {}
			async send() {
				try {
					const response = await window.fetch(this.url);
					this.status = response.status;
					const bytes = await response.arrayBuffer();
					this.responseText = new TextDecoder().decode(bytes);
					this.response =
						this.responseType === "arraybuffer"
							? bytes
							: this.responseType === "json"
								? JSON.parse(this.responseText)
								: this.responseText;
					this.readyState = 4;
					for (const type of ["readystatechange", "load", "loadend"]) {
						const event = new window.Event(type);
						this.dispatchEvent(event);
					}
				} catch {
					this.onerror?.(new window.Event("error"));
				}
			}
		}
		window.XMLHttpRequest = (globalThis as any).XMLHttpRequest = XHR;
		class PlayerSocket extends window.EventTarget {
			[key: string]: any;
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			CONNECTING = 0;
			OPEN = 1;
			CLOSING = 2;
			CLOSED = 3;
			transport: SocketTransport;
			constructor(url: string | URL, protocols?: string | string[]) {
				super();
				bindEventProperties(this, ["open", "message", "close", "error"]);
				runtime.updater.assertReady();
				this.transport = new SocketTransport(String(url), protocols);
				runtime.sockets.add(this);
				this.transport.on("open", () => this.deliver("open", new window.Event("open")));
				this.transport.on("message", (data, binary) => {
					this.deliver("message", new window.MessageEvent("message", { data: binary ? data : data.toString() }));
				});
				this.transport.on("error", () => this.deliver("error", new window.Event("error")));
				this.transport.on("close", (code, reason) => {
					runtime.sockets.delete(this);
					this.deliver("close", new window.CloseEvent("close", { code, reason: reason.toString() }));
					if (!runtime.closed && !this._nocallback) runtime.options.onDisconnect({ code, reason: reason.toString().slice(0, 200) });
				});
			}
			get readyState() {
				return this.transport.readyState;
			}
			get url() {
				return this.transport.url;
			}
			get bufferedAmount() {
				return this.transport.bufferedAmount;
			}
			close(code?: number, reason?: string) {
				this.transport.close(code, reason);
			}
			private deliver(type: string, event: any) {
				if (runtime.closed) return;
				this.dispatchEvent(event);
			}
			send(data: any) {
				runtime.updater.assertReady();
				try {
					const packet = JSON.parse(String(data));
					if (packet[0] === "server" && packet[1] === "create") {
						runtime.options.onEvent("blocked", { reason: "客户端禁止创建房间" });
						return;
					}
				} catch {}
				this.transport.send(data);
			}
		}

		window.WebSocket = (globalThis as any).WebSocket = PlayerSocket;
		window.eval(`(${installView.toString()})()`);
		this.observer = new window.MutationObserver(() => {
			void this.loadElements();
		});
		this.observer.observe(window.document, { childList: true, subtree: true });
		await this.loadElements();
		window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
		window.dispatchEvent(new window.Event("load"));
	}
	private async loadElements() {
		const { document } = this.window;
		for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
			if (this.loadedLinks.has(link)) continue;
			this.loadedLinks.add(link);
			try {
				const bytes = await this.updater.read(link.href);
				if (bytes) {
					const style = document.createElement("style");
					style.textContent = bytes.toString();
					document.head.append(style);
				}
				link.dispatchEvent(new this.window.Event("load"));
			} catch {
				this.fail();
			}
		}
		for (const script of document.querySelectorAll("script[src]")) {
			if (this.loadedScripts.has(script)) continue;
			this.loadedScripts.add(script);
			if (script.type === "module")
				void import(script.src).then(() => script.dispatchEvent(new this.window.Event("load"))).catch(() => this.fail());
			else {
				try {
					const bytes = await this.updater.read(script.src);
					if (!bytes) throw new Error("missing");
					this.window.eval(bytes.toString());
					script.dispatchEvent(new this.window.Event("load"));
				} catch {
					this.fail();
				}
			}
		}
	}
	async joinPublicRoom(room: string) {
		this.check();
		const node = Array.from(this.window.document.querySelectorAll(".dialog .popup.text.pointerdiv")).find(
			(node: any) => this.visible(node) && String(node.closest(".caption")?.key) === room
		) as any;
		if (!node) throw new Error("邀请对应的房间不在当前大厅，可能已关闭");
		node.dispatchEvent(new this.window.MouseEvent("click", { bubbles: true, cancelable: true }));
	}
	async restoreConnection(server: string, room?: string) {
		this.activeServer = new URL(server).href;
		const saved = this.connectionSettings;
		if (!this.publicModule || !saved || !room || saved.room !== room || new URL(saved.server).href !== this.activeServer) return;
		const { lib } = await import(this.publicModule);
		// Restore only this profile's normal reconnect settings for the explicitly requested room.
		lib.config.reconnect_info = structuredClone(saved.reconnect);
		// The browser compares this field to the input text, not URL equivalence (:443 and / differ).
		lib.config.reconnect_info[0] = server;
	}
	async saveConnection() {
		if (!this.profile || !this.publicModule || !this.activeServer) return;
		const { lib, game } = await import(this.publicModule);
		const reconnect = lib.config.reconnect_info;
		if (
			game.observe ||
			!game.roomId ||
			!Array.isArray(reconnect) ||
			typeof reconnect[0] !== "string" ||
			typeof reconnect[1] !== "string" ||
			!reconnect[1] ||
			game.onlineID !== reconnect[1]
		)
			return;
		const storage: Record<string, string> = {};
		for (let i = 0; i < this.window.localStorage.length; i++) {
			const key = this.window.localStorage.key(i);
			if (key?.endsWith("_key")) storage[key] = this.window.localStorage.getItem(key);
		}
		try {
			const savedReconnect: ConnectionSettings["reconnect"] = [reconnect[0], reconnect[1]];
			if (typeof reconnect[2] === "string") savedReconnect.push(reconnect[2]);
			await this.profile.save({
				server: this.activeServer,
				room: String(game.roomId),
				reconnect: savedReconnect,
				storage,
			});
			this.profileWarning = false;
		} catch {
			if (!this.profileWarning) this.options.onEvent("warning", { message: "无法保存自己的重连资料；当前对局可继续，重启后可能无法恢复席位" });
			this.profileWarning = true;
		}
	}
	async describePublic(name: string) {
		this.check();
		if (!this.publicModule) throw new Error("当前站点没有公开武将资料接口");
		const { lib } = await import(this.publicModule);
		const characters = Object.assign({}, ...Object.values(lib.characterPack ?? {}), lib.character);
		const plain = (value: unknown) => {
			if (typeof value !== "string") return "";
			const element = this.window.document.createElement("div");
			element.innerHTML = value;
			for (const tip of element.querySelectorAll("[poptip]"))
				tip.textContent = typeof tip.name === "string" ? tip.name : lib.poptip.getName(tip.getAttribute("poptip"));
			return element.textContent.replace(/\s+/g, " ").trim();
		};
		const key = Object.keys(characters).find((id) => id === name || plain(lib.translate[id]).replace(/\s/g, "") === name.replace(/\s/g, ""));
		if (!key) throw new Error("当前版本没有此武将，请核对完整显示名称");
		const entry: any = characters[key];
		const character = Array.isArray(entry) ? { sex: entry[0], group: entry[1], hp: entry[2], skills: entry[3] } : entry;
		return {
			name: plain(lib.translate[key]),
			source: "public-character-descriptions",
			sex: plain(lib.translate[character.sex]) || character.sex,
			faction: plain(lib.translate[character.group]) || character.group,
			health: character.hp,
			biography: plain(lib.characterIntro?.[key]),
			skills: (character.skills ?? [])
				.map((id: string) => ({ name: plain(lib.translate[id]), description: plain(lib.translate[id + "_info"]) }))
				.filter((skill: any) => skill.name && skill.description),
		};
	}
	async describePublicPlayers(players: { id: string }[]) {
		if (!this.publicModule || !players.length) return {};
		const { get, lib } = await import(this.publicModule);
		return readPublicDetails(
			this.window,
			players,
			{
				intro: (node) => get.nodeintro(node, true),
				poptipName: (id) => lib.poptip.getName(id),
			},
			(node) => this.visible(node)
		);
	}
	async readPublicEvents(): Promise<{ type: string; text: string; sender?: string }[]> {
		if (!this.publicModule || !this.window.document.querySelector("#system")) return [];
		const { lib, ui } = await import(this.publicModule);
		const plain = (html: unknown) => {
			if (typeof html !== "string") return "";
			const node = this.window.document.createElement("div");
			node.innerHTML = html;
			for (const hidden of node.querySelectorAll("script,style,.infohidden")) hidden.remove();
			return node.textContent.replace(/\s+/g, " ").trim();
		};
		const events: { type: string; text: string; sender?: string }[] = [];
		// These are the normal player-facing Records and Chat panels, even when closed.
		for (const node of Array.from(ui.sidebar?.children ?? []).reverse() as any[]) {
			if (this.seenPublicLogs.has(node)) continue;
			this.seenPublicLogs.add(node);
			const text = plain(node.innerHTML);
			if (text) events.push({ type: "log", text });
		}
		const history = lib.chatHistory ?? [];
		if (history.length < this.chatCursor) this.chatCursor = 0;
		for (const [sender, message] of history.slice(this.chatCursor))
			events.push({ type: "chat", sender: plain(sender), text: plain(message) || "[表情]" });
		this.chatCursor = history.length;
		return events;
	}
	async close() {
		if (this.closed) return;
		await this.saveConnection().catch(() => {});
		this.closed = true;
		this.observer?.disconnect();
		for (const timer of this.timers) clearTimeout(timer);
		for (const socket of this.sockets) socket.close();
		await Promise.all([...this.sockets].map((socket) => socket.transport.dispose()));
		await this.window?.happyDOM.close();
		this.port?.close();
		globalThis.fetch = nativeFetch;
		globalThis.WebSocket = NativeWebSocket;
		this.emit("close");
	}
}
