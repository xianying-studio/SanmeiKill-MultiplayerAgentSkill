/** Extract only the text a player can see in normal character/mark tooltips. */
export function readPublicDetails(window, players, api, visible) {
    const plain = (node) => {
        if (!node)
            return "";
        const clone = node.cloneNode(true);
        for (const hidden of clone.querySelectorAll("script,style,.infohidden,.hidden,.underlinenode,.skillbutton"))
            hidden.remove();
        for (const tip of clone.querySelectorAll("[poptip]"))
            tip.textContent = api.poptipName(tip.getAttribute("poptip")) || tip.textContent;
        return clone.textContent.replace(/\s+/g, " ").trim();
    };
    const result = {};
    for (const { id } of players) {
        const player = window.document.querySelector(`[data-player-client-id="${id}"]`);
        if (!player || !visible(player))
            continue;
        const identity = player.querySelector(".identity");
        const label = identity && visible(identity) && !identity.closest(".guessing,.infohidden") ? plain(identity) : "";
        const details = { identity: label && !/未知|猜|\?/.test(label) ? label : null, skills: [], indicators: [] };
        try {
            const tooltip = api.intro(player);
            for (const header of tooltip?.querySelectorAll(".skill") ?? []) {
                if (header.querySelector(".card") || !header.nextElementSibling)
                    continue;
                const name = plain(header), description = plain(header.nextElementSibling);
                if (!name || !description)
                    continue;
                let disabled = false;
                for (let n = header; n && n !== tooltip; n = n.parentElement)
                    if (n.style.opacity && Number(n.style.opacity) < 1)
                        disabled = true;
                details.skills.push({ name, description, disabled });
            }
            tooltip?.remove();
        }
        catch {
            details.skillsUnavailable = true;
        }
        for (const node of player.querySelectorAll(".marks > .mark, .tipContainer > .tip")) {
            if (!visible(node))
                continue;
            const text = plain(node);
            let name = text, description = text;
            try {
                const tooltip = api.intro(node);
                name = plain(tooltip?.querySelector(".caption")) || text;
                description = plain(tooltip?.content ?? tooltip) || text;
                tooltip?.remove();
            }
            catch {
                /* Keep the visible label even if the game's tooltip is unavailable. */
            }
            details.indicators.push({ name, text, description });
        }
        result[id] = details;
    }
    return result;
}
