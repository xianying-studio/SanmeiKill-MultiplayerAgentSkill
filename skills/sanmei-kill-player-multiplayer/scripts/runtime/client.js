import { NodeRuntime } from "./node-runtime.js";
import { parseInvitation } from "./invite.js";
import { Journal } from "./events.js";
import { resourceSource, checkLocalPackage } from "./resources.js";
import { ResourceUpdater } from "./update.js";
import { diffSnapshots } from "./diff.js";
export function playerNickname(value = "AI玩家") {
    const name = value.trim();
    if (!name || [...name].length > 24 || /[<>\x00-\x1f\x7f]/.test(value))
        throw new Error("昵称须为 1～24 字的单行纯文本");
    return name;
}
export class PlayerClient {
    options;
    context;
    page;
    journal = new Journal();
    revision = 0;
    view;
    phase = "loading";
    server = "";
    updater;
    timer;
    closed = false;
    lastChat = 0;
    decisionKey = "";
    disconnected = false;
    runtimeFailed = false;
    viewVersion = 0;
    nextDetailsAt = 0;
    refreshTask;
    serial = Promise.resolve();
    constructor(options) {
        this.options = options;
        options.nickname = playerNickname(options.nickname);
        this.updater = new ResourceUpdater({
            site: options.site,
            package: options.package,
            cache: options.profile + ".resources",
            onState: (state) => {
                this.phase = state.phase === "ready" ? "loading" : `update_${state.phase}`;
                this.journal.append("update", state);
            },
        });
    }
    async start() {
        const site = new URL(resourceSource(this.options.site, this.options.package).site);
        await checkLocalPackage(this.options.package);
        await this.updater.prepare();
        if (this.closed)
            throw new Error("客户端已停止");
        this.context = this.page = new NodeRuntime(this.updater, {
            nickname: this.options.nickname,
            onEvent: (type, data) => {
                if (type === "error") {
                    this.runtimeFailed = true;
                    this.phase = "error";
                }
                this.journal.append(type, data);
            },
            onDisconnect: () => {
                this.disconnected = true;
                if (this.phase !== "over")
                    this.phase = "disconnected";
                this.journal.append("disconnected", { text: "联机连接已断开，旧操作不可再提交" });
            },
        });
        this.page.on("close", () => {
            this.phase = "closed";
            this.journal.append("closed", {});
        });
        await this.page.goto(site.href, { waitUntil: "domcontentloaded" });
        this.poll();
        // Wait for the shell to finish binding its import/start event handlers.
        await this.page.locator("#loading-screen.show-start-btn").waitFor({ timeout: 60000 });
        await this.page.locator("#loading-start-btn").click();
        await this.page.locator("#splash, #arena").first().waitFor({ timeout: 600000 });
        await this.page.locator('#window > [contenteditable="true"]').waitFor({ timeout: 60000 });
        const input = this.page.locator('#window > [contenteditable="true"]').filter({ visible: true });
        this.server = (await input.innerText()).trim();
        const targetServer = this.options.invite ? parseInvitation(this.options.invite).server : this.options.server;
        if (targetServer) {
            const endpoint = new URL(targetServer);
            if (!["ws:", "wss:"].includes(endpoint.protocol))
                throw new Error("服务器必须使用 ws:// 或 wss://");
            this.server = endpoint.href;
            await input.fill(this.server);
        }
        this.journal.append("server", { url: this.server, source: this.options.server ? "custom" : "visible-game-page" });
        await this.page.getByText("连接", { exact: true }).click();
        await this.page
            .getByText("创建房间", { exact: true })
            .or(this.page.locator("#system").getByText("聊天", { exact: true }))
            .waitFor({ timeout: 60000 });
        this.phase = (await this.page.getByText("房间信息", { exact: true }).count()) ? "joined" : "lobby";
        await this.refresh();
        if (this.options.invite)
            await this.joinInvitation(this.options.invite);
    }
    poll() {
        if (this.closed)
            return;
        this.timer = setTimeout(async () => {
            try {
                await this.refresh();
            }
            catch {
                /* Navigation temporarily destroys the DOM context. */
            }
            this.poll();
        }, 200);
    }
    run(fn) {
        const result = this.serial.then(fn, fn);
        this.serial = result.catch(() => { });
        return result;
    }
    refresh() {
        return (this.refreshTask ??= this.readView().finally(() => {
            this.refreshTask = undefined;
        }));
    }
    async readView() {
        if (this.page.isClosed() || this.runtimeFailed)
            return;
        const result = await this.page.evaluate(() => {
            const adapter = window.sanmeiPlayerView;
            return adapter ? { view: adapter.read(), events: adapter.drain() } : null;
        });
        if (!result)
            return;
        if (this.updater.state.phase !== "ready")
            return;
        if (Date.now() >= this.nextDetailsAt || JSON.stringify(this.view?.players) !== JSON.stringify(result.view.players)) {
            result.view.details = await this.page.describePublicPlayers(result.view.players);
            this.nextDetailsAt = Date.now() + 1000;
        }
        else
            result.view.details = this.view?.details ?? {};
        for (const event of await this.page.readPublicEvents())
            this.journal.append(event.type, event);
        if (result.view.connection && !this.disconnected && this.phase !== "over")
            this.phase = result.view.connection;
        for (const event of result.events)
            this.journal.append("visible_event", event);
        if (JSON.stringify(this.view) !== JSON.stringify(result.view)) {
            const previousView = this.view;
            if (this.view?.turn?.playerId !== result.view.turn?.playerId)
                this.journal.append("turn", result.view.turn);
            for (const player of result.view.players) {
                if (player.dead && !this.view?.players.find((p) => p.id === player.id)?.dead)
                    this.journal.append("death", player);
            }
            this.view = result.view;
            const decisionKey = JSON.stringify({
                rooms: this.view.rooms,
                players: this.view.players,
                hand: this.view.hand,
                actions: this.view.actions,
                dialogs: this.view.dialogs,
                turn: this.view.turn,
                autoplay: this.view.autoplay,
                details: this.view.details,
            });
            if (this.decisionKey !== decisionKey) {
                this.decisionKey = decisionKey;
                this.revision++;
            }
            const outcome = this.view.dialogs.find((text) => /^(战斗胜利|战斗失败|平局)(?:\s|$)/.test(text));
            if (outcome && this.phase !== "over") {
                this.phase = "over";
                this.journal.append("game_over", { text: outcome });
            }
            const baseVersion = this.viewVersion++;
            if (!previousView)
                this.journal.append("view", { version: this.viewVersion, revision: this.revision, view: this.view });
            else
                this.journal.append("view_patch", {
                    baseVersion,
                    version: this.viewVersion,
                    revision: this.revision,
                    patch: diffSnapshots(previousView, this.view),
                });
        }
    }
    status() {
        return {
            phase: this.phase,
            update: { ...this.updater.state },
            resources: resourceSource(this.options.site, this.options.package),
            server: this.server,
            nickname: this.options.nickname,
            revision: this.revision,
            viewVersion: this.viewVersion,
            cursor: this.journal.cursor,
            view: this.view,
        };
    }
    summary() {
        return { phase: this.phase, revision: this.revision, viewVersion: this.viewVersion, cursor: this.journal.cursor };
    }
    async join(id, revision) {
        this.updater.assertReady();
        await this.refresh();
        if (this.phase !== "lobby")
            throw new Error("只能从大厅加入已有房间");
        this.checkRevision(revision);
        if (!this.view?.rooms.some((r) => r.id === id))
            throw new Error("房间已变化，请重新读取 rooms");
        await this.page.locator(`[data-player-client-id="${id}"]`).click();
        await this.page.locator("#system").getByText("聊天", { exact: true }).waitFor({ timeout: 15000 });
        this.phase = "joined";
        this.journal.append("joined", { room: id, text: "等待浏览器端房主开始游戏" });
        await this.refresh();
        return this.status();
    }
    async joinInvitation(text) {
        this.updater.assertReady();
        if (this.phase !== "lobby")
            throw new Error("只能从大厅加入邀请房间");
        const invitation = parseInvitation(text);
        if (new URL(this.server).href !== invitation.server)
            throw new Error("邀请属于另一个服务器，请 stop 后使用 start --invite-file 启动对应会话");
        await this.page.joinPublicRoom(invitation.room);
        await this.page.locator("#system").getByText("聊天", { exact: true }).waitFor({ timeout: 15000 });
        this.phase = "joined";
        this.journal.append("joined", { room: invitation.room, source: "invitation" });
        await this.refresh();
        return this.status();
    }
    checkRevision(revision) {
        if (revision !== this.revision)
            throw new Error("状态已变化，请读取最新状态后重新决策");
    }
    async act(id, revision) {
        this.updater.assertReady();
        await this.refresh();
        this.checkRevision(revision);
        if (this.disconnected || this.phase !== "joined" || !this.view?.actions.some((a) => a.id === id))
            throw new Error("当前不是可操作时机，或选项不可用");
        await this.page.locator(`[data-player-client-id="${id}"]`).click({ timeout: 3000 });
        await this.refresh();
        return this.status();
    }
    async say(text) {
        this.updater.assertReady();
        if (!["joined", "over"].includes(this.phase))
            throw new Error("加入房间后才能聊天");
        if (typeof text !== "string" || !text.trim() || text.length > 200 || /[<>\x00-\x1f]/.test(text))
            throw new Error("聊天须为 1～200 字的单行纯文本");
        if (Date.now() - this.lastChat < 10000)
            throw new Error("聊天发送过于频繁，请至少间隔 10 秒");
        const button = this.page.locator("#system").getByText("聊天", { exact: true });
        await button.hover();
        const input = this.page.locator('.dialog.popped input[type="text"]');
        await input.waitFor({ timeout: 3000 });
        await input.fill(text);
        this.lastChat = Date.now();
        await input.press("Enter");
        this.journal.append("chat_submitted", { text });
        // Do not retry a send on acknowledgement timeout: that could duplicate a message.
        await this.page
            .locator(".text.chat")
            .filter({ hasText: text })
            .waitFor({ timeout: 5000 })
            .catch(() => { });
        const echoed = (await this.page.locator(".text.chat").filter({ hasText: text }).count()) > 0;
        await this.page.mouse.move(5, 500);
        await this.refresh();
        return { submitted: true, echoed, text };
    }
    async describe(name) {
        this.updater.assertReady();
        if (typeof name !== "string" || !name.trim() || name.length > 80)
            throw new Error("请提供完整武将名称");
        if (!["lobby", "joined", "over"].includes(this.phase))
            throw new Error("请等待游戏加载完成");
        return this.page.describePublic(name);
    }
    async autoplay(enabled) {
        this.updater.assertReady();
        if (typeof enabled !== "boolean")
            throw new Error("托管状态必须为 on 或 off");
        await this.refresh();
        if (this.disconnected || this.phase !== "joined" || !this.view?.autoplay?.available)
            throw new Error("当前无法切换托管");
        if (this.view.autoplay.enabled === enabled)
            return this.status();
        await this.page.locator("#system").getByText("托管", { exact: true }).click();
        await this.refresh();
        if (this.view.autoplay.enabled !== enabled)
            throw new Error("托管状态未改变，请读取最新状态后再决定");
        this.journal.append("autoplay", { enabled });
        return this.status();
    }
    async close() {
        this.closed = true;
        clearTimeout(this.timer);
        await this.context?.close();
        await this.updater.close();
    }
}
