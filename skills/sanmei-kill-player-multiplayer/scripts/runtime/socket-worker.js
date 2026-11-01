import { parentPort, workerData } from "node:worker_threads";
import WebSocket from "ws";
// Keep transport liveness independent of synchronous DOM/style work on the game thread.
const port = parentPort;
const socket = new WebSocket(workerData.url, workerData.protocols);
socket.on("open", () => port.postMessage({ type: "open", url: socket.url }));
socket.on("message", (data, binary) => {
    if (!binary && data.toString() === "heartbeat") {
        if (socket.readyState === WebSocket.OPEN)
            socket.send("heartbeat");
        return;
    }
    port.postMessage({ type: "message", data: binary ? data : data.toString(), binary });
});
socket.on("error", () => port.postMessage({ type: "error" }));
socket.on("close", (code, reason) => {
    port.postMessage({ type: "close", code, reason: reason.toString() });
    port.close();
});
port.on("message", (message) => {
    try {
        if (message.type === "send")
            socket.send(message.data, (error) => {
                port.postMessage({ type: "sent", size: message.size });
                if (error)
                    port.postMessage({ type: "error" });
            });
        else if (message.type === "close")
            socket.close(message.code, message.reason);
    }
    catch {
        port.postMessage({ type: "error" });
    }
});
