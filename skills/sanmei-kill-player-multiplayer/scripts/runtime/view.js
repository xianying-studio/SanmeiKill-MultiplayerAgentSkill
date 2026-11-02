/** DOM-only adapter. Never reads application globals, source, storage or network payloads. */
export function installView() {
    const root = window;
    let nextId = 1;
    const ids = new WeakMap();
    const events = [];
    const seenLogs = new WeakMap();
    let visibility = new WeakMap();
    let texts = new WeakMap();
    const beginRead = () => {
        visibility = new WeakMap();
        texts = new WeakMap();
    };
    const id = (node) => {
        if (!ids.has(node))
            ids.set(node, `v${nextId++}`);
        const value = ids.get(node);
        if (node.getAttribute("data-player-client-id") !== value)
            node.setAttribute("data-player-client-id", value);
        return value;
    };
    const visible = (node) => {
        if (visibility.has(node))
            return visibility.get(node);
        let value = false;
        if (node.isConnected && node.getClientRects().length) {
            const style = getComputedStyle(node);
            value =
                style.display !== "none" &&
                    style.visibility === "visible" &&
                    Number(style.opacity) !== 0 &&
                    (!node.parentElement || visible(node.parentElement));
        }
        visibility.set(node, value);
        return value;
    };
    const text = (node) => {
        if (texts.has(node))
            return texts.get(node);
        if (node.matches("#timer, .timer, .timerbar, .infohidden") ||
            !visible(node) ||
            ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "RT"].includes(node.tagName))
            return "";
        const value = Array.from(node.childNodes)
            .map((child) => (child.nodeType === Node.TEXT_NODE ? child.textContent : child instanceof Element ? text(child) : ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        texts.set(node, value);
        return value;
    };
    const nodes = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible);
    const describe = (node) => ({
        id: id(node),
        text: node.classList.contains("infohidden") ? "未知牌" : text(node) || (node.matches(".card") ? "未知牌" : "未标注选项"),
        selected: node.classList.contains("selected"),
    });
    const prohibited = /创建房间|开始游戏|启动服务器|旁观|托管|重来|再战|退出房间/;
    const read = () => {
        // A snapshot is synchronous: reuse ancestor styles/text only within this read.
        beginRead();
        const system = nodes("#system div");
        const observing = Boolean(document.querySelector("#arena.observe")) || system.some((n) => text(n) === "退出旁观");
        const autoButton = nodes("#system div").find((n) => text(n) === "托管");
        const autoplay = {
            available: Boolean(autoButton && nodes("#arena > .player").length),
            enabled: Boolean(document.querySelector("#arena.auto")),
        };
        const currentPlayer = nodes("#arena > .player.glow_phase")[0];
        const rooms = nodes(".dialog .popup.text.pointerdiv")
            .filter((n) => !/空房间/.test(text(n)))
            .map(describe);
        const controls = nodes("#control .control > div, #control > .control:not(:has(> div)), .card.selectable, .player.selectable, .button.selectable, .card.selected, .player.selected, .button.selected").filter((n) => !(n.closest("#control") && prohibited.test(text(n))) && !n.closest(".disabled, .unselectable"));
        const actions = [...new Set(controls)].map(describe);
        const animations = document.getAnimations().some((a) => {
            const target = a.effect?.target;
            if (target instanceof Element && target.closest("#timer, .timer, .timerbar"))
                return false;
            return a.playState === "running" && a.effect?.getTiming().iterations !== Infinity && a.effect?.getTiming().duration !== 0;
        });
        return {
            characterChoices: nodes(".button.character")
                .filter((n) => !n.classList.contains("infohidden"))
                .map((n) => {
                const name = text(n.querySelector(".name") ?? n).replace(/\s+/g, "");
                return { id: id(n), name, describe: { command: "describe", name } };
            }),
            autoplay,
            turn: currentPlayer ? { playerId: id(currentPlayer), text: text(currentPlayer) } : null,
            connection: observing
                ? "observing"
                : system.some((n) => ["房间信息", "聊天"].includes(text(n)))
                    ? "joined"
                    : nodes("#window > .connectevents").some((n) => text(n) === "创建房间")
                        ? "lobby"
                        : null,
            rooms,
            players: nodes("#arena > .player, #arena .player.dead").map((n) => ({
                ...describe(n),
                position: n.getAttribute("data-position"),
                dead: n.classList.contains("dead"),
                health: Array.from(n.querySelectorAll(".hp > div"))
                    .filter(visible)
                    .map((p) => ({ filled: !p.classList.contains("lost"), text: text(p) })),
            })),
            hand: observing ? [] : nodes("#handcards1 .card, #handcards2 .card").map(describe),
            dialogs: nodes(".dialog:not(.noupdate):not(.popped), #prompt, .prompt")
                .map((n) => text(n))
                .filter(Boolean),
            actions: observing || autoplay.enabled || animations || nodes(".menu-container:not(.hidden), .popup-container:not(.hidden)").length
                ? []
                : actions,
            animating: animations,
        };
    };
    const capture = () => {
        beginRead();
        for (const node of nodes("#historybar > *, .dialog:not(.popped) .caption")) {
            const value = text(node);
            if (value && seenLogs.get(node) !== value) {
                seenLogs.set(node, value);
                events.push({ type: "visible_event", text: value });
            }
        }
        if (events.length > 10000)
            events.splice(0, events.length - 9999, { type: "gap", text: "界面事件缓冲区溢出，请重新读取状态" });
    };
    const observe = () => new MutationObserver(capture).observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "style"],
    });
    if (document.documentElement)
        observe();
    else
        document.addEventListener("DOMContentLoaded", observe, { once: true });
    root.sanmeiPlayerView = { read, drain: () => events.splice(0) };
}
