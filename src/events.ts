export class Journal {
	private sequence = 0;
	private entries: { seq: number; at: string; type: string; data: unknown }[] = [];
	constructor(private capacity = 10000) {}
	get cursor() {
		return this.sequence;
	}
	append(type: string, data: unknown) {
		this.entries.push({ seq: ++this.sequence, at: new Date().toISOString(), type, data });
		if (this.entries.length > this.capacity) this.entries.shift();
	}
	read(after = 0) {
		if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence) throw new Error("无效的事件游标");
		const events = this.entries.filter((e) => e.seq > after).slice(0, 100);
		const cursor = events.at(-1)?.seq ?? after;
		return { cursor, latestCursor: this.sequence, hasMore: cursor < this.sequence, gap: after < (this.entries[0]?.seq ?? 1) - 1, events };
	}
}
