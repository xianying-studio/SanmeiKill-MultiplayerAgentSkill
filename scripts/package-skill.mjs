import { cp, mkdir } from "node:fs/promises";
const target = new URL("../skills/sanmei-kill-player-multiplayer/scripts/runtime/", import.meta.url);
await mkdir(target, { recursive: true });
await cp(new URL("../dist/", import.meta.url), target, { recursive: true, filter: (path) => !path.endsWith(".d.ts") });
