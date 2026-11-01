import { setTimeout as delay } from "node:timers/promises";
import type { NodeRuntime } from "./node-runtime.js";

export class DomLocator {
	constructor(
		readonly page: NodeRuntime,
		readonly query: () => any[]
	) {}
	locator(selector: string) {
		const visible = selector.includes(":visible");
		const css = selector.replaceAll(":visible", "");
		return new DomLocator(this.page, () =>
			this.query()
				.flatMap((node) => Array.from(node.querySelectorAll(css)))
				.filter((node) => !visible || this.page.visible(node))
		);
	}
	getByText(value: string, options: { exact?: boolean } = {}) {
		return new DomLocator(this.page, () =>
			this.query()
				.flatMap((root) => Array.from(root.querySelectorAll("*")))
				.filter((node: any) => {
					const match = (n: any) => (options.exact ? this.page.text(n) === value : this.page.text(n).includes(value));
					return match(node) && !Array.from(node.children).some(match);
				})
		);
	}
	filter(options: { visible?: boolean; hasText?: string }) {
		return new DomLocator(this.page, () =>
			this.query().filter(
				(node) => (!options.visible || this.page.visible(node)) && (!options.hasText || this.page.text(node).includes(options.hasText))
			)
		);
	}
	first() {
		return this.nth(0);
	}
	nth(index: number) {
		return new DomLocator(this.page, () => this.query().slice(index, index + 1));
	}
	or(other: DomLocator) {
		return new DomLocator(this.page, () => [...new Set([...this.query(), ...other.query()])]);
	}
	async count() {
		return this.query().length;
	}
	async waitFor(options: { timeout?: number; state?: string } = {}) {
		const deadline = Date.now() + (options.timeout ?? 10000);
		while (Date.now() < deadline) {
			this.page.check();
			const nodes = this.query();
			if (options.state === "detached" ? !nodes.length : nodes.some((node) => this.page.visible(node))) return;
			await delay(50);
		}
		throw new Error("等待玩家界面超时");
	}
	private async element(options: { timeout?: number } = {}) {
		await this.waitFor(options);
		return this.query().find((node) => this.page.visible(node));
	}
	async click(options: { timeout?: number; position?: { x: number; y: number } } = {}) {
		const element = await this.element(options);
		for (const type of ["mousedown", "mouseup", "click"])
			element.dispatchEvent(
				new this.page.window.MouseEvent(type, {
					bubbles: true,
					cancelable: true,
					button: 0,
					clientX: options.position?.x ?? 100,
					clientY: options.position?.y ?? 100,
				})
			);
	}
	async hover() {
		const element = await this.element();
		for (const type of ["mouseenter", "mouseover", "mousemove"])
			element.dispatchEvent(new this.page.window.MouseEvent(type, { bubbles: true, clientX: 100, clientY: 100 }));
	}
	async fill(text: string) {
		const element = await this.element();
		if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") element.value = text;
		else element.textContent = text;
		element.dispatchEvent(new this.page.window.Event("input", { bubbles: true }));
		element.dispatchEvent(new this.page.window.Event("change", { bubbles: true }));
	}
	async press(key: string) {
		const element = await this.element();
		for (const type of ["keydown", "keypress", "keyup"]) {
			const event = new this.page.window.KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true });
			Object.defineProperty(event, "keyCode", { value: key === "Enter" ? 13 : 0 });
			element.dispatchEvent(event);
		}
	}
	async innerText() {
		return (await this.element()).innerText;
	}
	async allInnerTexts(): Promise<string[]> {
		return this.query().map((node) => node.innerText);
	}
}
