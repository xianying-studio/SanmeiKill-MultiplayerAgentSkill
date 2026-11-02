import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
export class SocketTransport extends EventEmitter {
    url;
    readyState = 0;
    bufferedAmount = 0;
    worker;
    ended = false;
    exited;
    disposal;
    constructor(url, protocols) {
        super();
        this.url = url;
        this.worker = new Worker(new URL("./socket-worker.js", import.meta.url), { workerData: { url, protocols } });
        this.worker.on("message", (message) => {
            if (this.ended)
                return;
            if (message.type === "open") {
                if (this.readyState >= 2)
                    return;
                this.readyState = 1;
                this.url = message.url;
                this.emit("open");
            }
            else if (message.type === "sent")
                this.bufferedAmount = Math.max(0, this.bufferedAmount - message.size);
            else if (message.type === "message")
                this.emit("message", message.binary ? Buffer.from(message.data) : message.data, message.binary);
            else if (message.type === "error")
                this.emit("error", new Error("联机传输失败"));
            else if (message.type === "close")
                this.finish(message.code, message.reason);
        });
        this.worker.on("error", () => {
            if (!this.ended)
                this.emit("error", new Error("联机传输线程异常"));
        });
        this.exited = new Promise((resolve) => {
            this.worker.once("exit", () => {
                this.finish(1006, "联机传输线程已退出");
                resolve();
            });
        });
    }
    finish(code, reason) {
        if (this.ended)
            return;
        this.ended = true;
        this.readyState = 3;
        this.bufferedAmount = 0;
        this.emit("close", code, reason);
    }
    send(data) {
        if (this.readyState !== 1)
            throw new Error("联机连接未就绪");
        const size = typeof data === "string" ? Buffer.byteLength(data) : ArrayBuffer.isView(data) || data instanceof ArrayBuffer ? data.byteLength : 0;
        this.worker.postMessage({ type: "send", data, size });
        this.bufferedAmount += size;
    }
    close(code, reason) {
        if (this.readyState >= 2)
            return;
        this.readyState = 2;
        this.worker.postMessage({ type: "close", code, reason });
    }
    dispose() {
        return (this.disposal ??= this.disposeWorker());
    }
    async disposeWorker() {
        if (!this.ended)
            this.close(1000);
        let timer;
        try {
            // Drain queued sends and the close handshake; bound cleanup for an unresponsive peer.
            await Promise.race([
                this.exited,
                new Promise((resolve) => {
                    timer = setTimeout(resolve, 1000);
                }),
            ]);
        }
        finally {
            clearTimeout(timer);
        }
        await this.worker.terminate();
    }
}
