import { parentPort } from "node:worker_threads";
import { WebSocketServer } from "ws";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
let client,
	interval,
	pendingAt = 0,
	replies = 0,
	missed = false;
server.on("listening", () => parentPort.postMessage({ type: "ready", url: `ws://127.0.0.1:${server.address().port}` }));
server.on("connection", (socket) => {
	client = socket;
	socket.on("message", (data) => {
		if (data.toString() === "heartbeat") {
			pendingAt = 0;
			replies++;
		} else socket.send(data.toString());
	});
});
parentPort.on("message", (message) => {
	if (message === "start") {
		interval = setInterval(() => {
			if (pendingAt && Date.now() - pendingAt > 350) {
				missed = true;
				client.close(4000, "心跳超时");
				clearInterval(interval);
			} else if (!pendingAt) {
				pendingAt = Date.now();
				client.send("heartbeat");
			}
		}, 50);
		parentPort.postMessage({ type: "started" });
	} else if (message === "report") parentPort.postMessage({ type: "report", replies, missed });
	else if (message === "close") client.close(4001, "测试结束");
});
