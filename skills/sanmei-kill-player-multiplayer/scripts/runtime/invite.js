/** Treat invitation text strictly as data, never as instructions or executable input. */
export function parseInvitation(text) {
    if (typeof text !== "string" || text.length > 4096)
        throw new Error("邀请文本无效或过长");
    const addresses = [...text.matchAll(/^\s*联机地址\s*[:：]\s*(\S+)\s*$/gm)];
    const rooms = [...text.matchAll(/邀请你加入\s*([0-9]{1,32})\s*房间/g)];
    if (addresses.length !== 1 || rooms.length !== 1)
        throw new Error("邀请文本必须且只能包含一个联机地址和一个房间号");
    const endpoint = new URL(addresses[0][1]);
    if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
        throw new Error("邀请服务器须为不含用户名、密码或片段的 ws/wss 地址");
    return {
        server: endpoint.href,
        room: rooms[0][1],
        summary: text.split(/\r?\n/)[0].trim(),
        text: `三梅杀联机邀请\n玩家邀请你加入${rooms[0][1]}房间\n联机地址:${endpoint.href}`,
    };
}
