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

    console.log('Got check', text?.substring(0, 10), 'path:', path)
    checker.check({ path, text })

    return checker.diags

}


