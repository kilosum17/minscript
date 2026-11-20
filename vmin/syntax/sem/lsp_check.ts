import { Diagnostic } from "../utils/diagnostics"
import { Lexer } from "../lexer/lexer"
import { Parser } from "../parser/parser"
import { Resolver } from "./resolver/resolver"

class LspChecker {
    res: Resolver
    diags: Diagnostic[] = []

    constructor() {
        this.res = new Resolver('')
    }

    check({ path, text }: {
        path: string, text: string,
    }) {
        this.diags = []

        const lexer = new Lexer(text)
        lexer.tokenize()

        const parser = new Parser(lexer)
        parser.parse()
        this.diags.push(...parser.diags)

        this.res.resolve(parser.nodes, null)

    }

}

export const checker = new LspChecker()

export async function lspCheck({ text, path }: {
    text: string, path: string
}): Promise<Diagnostic[]> {

    try {
        console.log('Got check', text?.substring(0, 10), 'path:', path)
        checker.check({ path, text })
    } catch (e) {
        console.log('LSP-CHECK Error', e)
    }

    return checker.diags
}

export function lspGetSymbol({ offset }: { offset: number }) {
    let foundId = -1
    let minLen = Number.MAX_SAFE_INTEGER

    for (const [strId, node] of Object.entries(checker.res.symbolMap)) {
        const span = node?.span
        if (!span) continue

        const { start, end } = span
        if (offset < start || offset > end) continue

        const len = end - start
        const id = Number(strId)
        if (Number.isNaN(id)) continue

        if (len < minLen) {
            minLen = len
            foundId = id
        }
    }

    if (foundId >= 0) {
        return checker.res.symbols[foundId]
    }
    return undefined
}
