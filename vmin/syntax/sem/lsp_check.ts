import { Lexer } from "../lexer/lexer"
import { Parser } from "../parser/parser"
import { CheckFlow } from "./check_flow"
import { Diagnostic } from "./diagnostics"
import { readFile, readdir, stat } from "node:fs/promises"

export async function lspCheck({ text, path }: {
    text?: string, path: string
}): Promise<Diagnostic[]> {
    const diags = [] as Diagnostic[]

    diags.push(new Diagnostic(
        'BREAK_OUTSIDE_LOOP',
        { start: 10, end: 14 },
        'Not allowed as test',
    ))

    console.log('Got check', text?.substring(0, 10), 'path:', path)

    try {
        // const text = readFile(path, 'utf-8')
        const lexer = new Lexer(text || '')
        lexer.tokenize()
        const parser = new Parser(lexer)
        parser.parse()
        const check_flow = new CheckFlow(parser.nodes)
        return check_flow.diagnostics
    } catch (e) {
        console.warn('Error', e)
    }
    return diags

}


