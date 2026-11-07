// Loads std/prelude.ms once: parsed, resolved as the std package, and installed as the default
// prelude for `resolvePackage`. Import this module (directly or through the checker) before
// resolving user code.

import { readFileSync } from "node:fs"
import type * as A from "./ast.ts"
import type { Diagnostic } from "./diagnostic.ts"
import { parse } from "./parser.ts"
import { resolvePackage, setDefaultPrelude, type Resolution } from "./resolve.ts"

export type Prelude = { file: A.File, res: Resolution, diagnostics: Diagnostic[] }

let cached: Prelude | null = null

export function loadPrelude(): Prelude {
    if (cached !== null) return cached
    const src = readFileSync(new URL("../std/prelude.ms", import.meta.url))
    const parsed = parse(src)
    const res = resolvePackage([parsed.file], { prelude: null, std: true })
    cached = { file: parsed.file, res, diagnostics: [...parsed.diagnostics, ...res.diagnostics] }
    return cached
}

setDefaultPrelude(() => loadPrelude().res)
