// Runs the lexer and parser over the `.ms` corpus (see test/README.md):
// - test/lexer/*.ms:   zero diagnostics, and the token dump must match the `.tokens` snapshot;
// - test/parser/*.ms:  zero diagnostics, and the AST dump must match the `.ast` snapshot;
// - test/programs:     zero diagnostics;
// - test/errors:       the diagnostics must match the `//~` annotations exactly (code and line).
//
// UPDATE_SNAPSHOTS=1 rewrites the snapshots (npm run test:update). Review the diff before committing.

import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { LEXER_CODES } from "../src/diagnostic.ts"
import { dumpTokens } from "../src/dump.ts"
import { lex } from "../src/lexer.ts"
import { parse } from "../src/parser.ts"
import { printFile } from "../src/sexpr.ts"

const root = dirname(fileURLToPath(import.meta.url))
const update = process.env.UPDATE_SNAPSHOTS === "1"

function msFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) out.push(...msFiles(path))
        else if (name.endsWith(".ms")) out.push(path)
    }
    return out
}

const rel = (p: string) => relative(root, p)

function diagnosticList(src: Buffer): string[] {
    return parse(src).diagnostics.map((d) => `${d.span.line}:${d.span.col} ${d.code} ${d.message}`)
}

function snapshot(file: string, ext: string, actual: string): void {
    const snap = file.replace(/\.ms$/, ext)
    if (update || !existsSync(snap)) {
        writeFileSync(snap, actual)
        return
    }
    assert.equal(actual, readFileSync(snap, "utf8"), `${rel(snap)} is out of date (run \`npm run test:update\` and review the diff)`)
}

describe("lexer snapshots (test/lexer)", () => {
    for (const file of msFiles(join(root, "lexer"))) {
        test(rel(file), () => {
            const src = readFileSync(file)
            assert.deepEqual(diagnosticList(src), [])
            snapshot(file, ".tokens", dumpTokens(lex(src)))
        })
    }
})

describe("parser snapshots (test/parser)", () => {
    for (const file of msFiles(join(root, "parser"))) {
        test(rel(file), () => {
            const src = readFileSync(file)
            const res = parse(src)
            assert.deepEqual(diagnosticList(src), [])
            snapshot(file, ".ast", printFile(res.file))
        })
    }
})

describe("programs parse cleanly (test/programs)", () => {
    for (const file of msFiles(join(root, "programs"))) {
        test(rel(file), () => {
            assert.deepEqual(diagnosticList(readFileSync(file)), [])
        })
    }
})

/** `//~ CODE CODE2` annotations, found by scanning the raw text (see test/README.md). */
function annotations(text: string): string[] {
    const out: string[] = []
    text.split("\n").forEach((line, i) => {
        const m = /\/\/~\s*((?:E_[A-Z_]+\s*)+)/.exec(line)
        if (!m) return
        for (const code of m[1]!.trim().split(/\s+/)) out.push(`${i + 1} ${code}`)
    })
    return out
}

describe("diagnostics match annotations (test/errors)", () => {
    for (const file of msFiles(join(root, "errors"))) {
        const text = readFileSync(file, "utf8")
        test(`${rel(file)}: lexer`, () => {
            const expected = annotations(text).filter((a) => LEXER_CODES.has(a.split(" ")[1]!)).sort()
            const actual = lex(text).diagnostics.map((d) => `${d.span.line} ${d.code}`).sort()
            assert.deepEqual(actual, expected)
        })
        test(`${rel(file)}: lexer + parser`, () => {
            const expected = annotations(text).sort()
            const actual = parse(text).diagnostics.map((d) => `${d.span.line} ${d.code}`).sort()
            assert.deepEqual(actual, expected)
        })
    }
})
