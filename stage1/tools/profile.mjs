// Reads a V8 CPU profile of a MinScript program (`node --cpu-prof … exec.ts <module.mjs> …`) and
// prints where the time goes, by MinScript function: each function's own time including the runtime
// code it calls (`clone`, `dyn`, string helpers…), then which runtime functions each caller spends on.
//
//   node --cpu-prof --cpu-prof-dir=/tmp/prof ../minscript/src/js/exec.ts stage1.mjs js .
//   node tools/profile.mjs /tmp/prof [rows]
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const dir = process.argv[2]
const rows = Number(process.argv[3] ?? 30)
if (!dir) {
    console.error("usage: node tools/profile.mjs <profile dir> [rows]")
    process.exit(2)
}
// the child process writes its own profile: take the largest
const file = readdirSync(dir).map((n) => join(dir, n)).sort((a, b) => statSync(b).size - statSync(a).size)[0]
const p = JSON.parse(readFileSync(file, "utf8"))
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

const own = new Map(), viaRuntime = new Map()
let total = 0
const add = (m, k, d) => m.set(k, (m.get(k) ?? 0) + d)
p.samples.forEach((id, i) => {
    const d = p.timeDeltas[i]
    total += d
    let cur = id, via = null
    while (cur !== undefined) {
        const m = byId.get(cur)
        const fn = m.callFrame.functionName || "(closure)"
        if (m.callFrame.url.endsWith(".mjs")) {
            add(own, fn, d)
            if (via) add(viaRuntime, `${fn} → ${via}`, d)
            return
        }
        if (!via && m.callFrame.url.includes("runtime")) via = m.callFrame.functionName
        cur = parent.get(cur)
    }
    add(own, `(outside MinScript: ${byId.get(id).callFrame.functionName || "?"})`, d)
})
const show = (title, m) => {
    console.log(`== ${title}`)
    for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, rows)) console.log(`${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`)
}
console.log(`${(total / 1e6).toFixed(2)} s sampled`)
show("by MinScript function (with the runtime code it calls)", own)
show("runtime code, by caller", viaRuntime)
