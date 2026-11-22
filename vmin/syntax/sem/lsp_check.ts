import { Diagnostic } from "../utils/diagnostics"
import { Lexer } from "../lexer/lexer"
import { Parser } from "../parser/parser"
import { Resolver } from "./resolver/resolver"
import { walkAstTree } from "./resolver/walk_ast_tree"
import { getNodeId } from "./utils/res_utils"
import { printAstNode, printAstType } from "../parser/ast_utils"
import { SemAnalysis } from "./type/SemAnalysis"
import type { AstNode } from "../parser/ast_types"
import { getScopeSymbolAt } from "./type/scope_get_symbol"
import { printBindingType } from "./type/scope_utils"
import { resetId } from "./type/sem_utils"

class LspChecker {
    res: SemAnalysis
    diags: Diagnostic[] = []
    nodes = {} as Record<string, AstNode[]>

    constructor() {
        this.res = new SemAnalysis()
    }

    check({ path, text }: {
        path: string, text: string,
    }) {
        this.diags = []

        const lexer = new Lexer(text)
        lexer.tokenize()

        const parser = new Parser(lexer)
        parser.parse()

        this.nodes[path] = parser.nodes

        this.diags.push(...parser.diags)

        this.res.analyze(parser.nodes)

    }

}

export const checker = new LspChecker()

export async function lspCheck({ text, path }: {
    text: string, path: string
}): Promise<Diagnostic[]> {

    try {
        resetId()
        console.log('Got check', text?.substring(0, 10), 'path:', path)
        checker.check({ path, text })
    } catch (e) {
        console.log('LSP-CHECK Error', e)
    }

    return checker.diags
}

export function lspGetSymbol({ offset, path }: {
    offset: number, path: string,
}) {

    console.log(`>>>Checking path ${path}`)
    const nodes = checker.nodes[path] || []
    const node = walkAstTree(nodes, offset)

    if (!node) {
        return
    }
    // console.log(`Found `, printAstType(node))

    let name = ''
    if (node?.kind === 'NameDecl') {
        name = node.text
    } else if (node?.kind === 'Var') {
        name = node.name
    }

    if (!name) {
        return
    }
    const res = getScopeSymbolAt(checker.res.file_scope, name, offset)
    console.log('Find symbol for ', name)
    return { ...res, name }
}

