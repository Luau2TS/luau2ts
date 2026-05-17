import { compile } from '../dist/index.js';

const src = `local cashValue = Players.LocalPlayer:WaitForChild("leaderstats"):WaitForChild("Cash")
local function format(n)
        local s = tostring(math.floor(n))
        local withCommas = string.reverse(string.gsub(string.reverse(s), "(%d%d%d)", "%1,"))
        withCommas = string.gsub(withCommas, "^,", "")
        return "$" .. withCommas
end`;

const r = await compile(src, { sourceFile: 'canary.lua', pretty: true, compatMode: 'rbxts' });
console.log(r.source);
console.log('--- errors ---');
for (const e of r.errors ?? []) console.log(e.message ?? e);
