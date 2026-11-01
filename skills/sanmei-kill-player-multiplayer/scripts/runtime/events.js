export class Journal {
    capacity;
    sequence = 0;
    entries = [];
    constructor(capacity = 10000) {
        this.capacity = capacity;
    }
    get cursor() {
        return this.sequence;
    }
    append(type, data) {
        this.entries.push({ seq: ++this.sequence, at: new Date().toISOString(), type, data });
        if (this.entries.length > this.capacity)
            this.entries.shift();
    }
    read(after = 0) {
        if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence)
            throw new Error("无效的事件游标");
        const events = this.entries.filter((e) => e.seq > after).slice(0, 100);
        const cursor = events.at(-1)?.seq ?? after;
        return { cursor, latestCursor: this.sequence, hasMore: cursor < this.sequence, gap: after < (this.entries[0]?.seq ?? 1) - 1, events };
    }
}
