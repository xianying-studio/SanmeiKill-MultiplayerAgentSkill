import { open } from "node:fs/promises";

export const defaultGameSite = "https://sanmei-kill.xianying.online/";

export function resourceSource(site = defaultGameSite, packagePath?: string) {
	const url = new URL(site);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("游戏地址必须使用 HTTP(S)，且不能包含账号密码");
	}
	return { site: url.href, mode: packagePath ? "local-package" : "website" };
}

// An explicitly selected local package must never silently trigger a large download.
export async function checkLocalPackage(packagePath?: string) {
	if (!packagePath) return;
	const file = await open(packagePath, "r");
	try {
		if (!(await file.stat()).isFile()) throw new Error("--package 必须指向本地 .smk 文件");
		const magic = Buffer.alloc(8);
		await file.read(magic, 0, magic.length, 0);
		if (magic.toString("ascii") !== "SMKPACK1") throw new Error("本地包体格式无效；不会自动回退到在线下载");
	} finally {
		await file.close();
	}
}
