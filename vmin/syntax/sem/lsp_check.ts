import { Diagnostic } from "../utils/diagnostics"
import { Lexer } from "../lexer/lexer"
import { Parser } from "../parser/parser"
import { Resolver } from "./resolver/resolver"
import { walkAstTree } from "./resolver/walk_ast_tree"
import { getNodeId } from "./utils/res_utils"
import { printAstNode, printAstType } from "../parser/ast_utils"

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
    const node = walkAstTree(checker.res.astNodes, offset)
    if (node) {
        console.log(`Found `, printAstType(node))
    }
    const nodeId = getNodeId(node)
    return checker.res.symbols[nodeId]
}

