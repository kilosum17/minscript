import type { Lexer } from "../lexer/lexer";
import type { AstNode, ImportDecl, PackageDecl } from "./ast_types";
import { printAstNode } from "./ast_utils";

export class Parser {
    nodes = [] as AstNode[]

    constructor(
        private lex: Lexer
    ) {

    }

    parse() {
        this.nodes = []

        while (true) {
            const node = this.getNode()
            if (!node) {
                break
            }
            console.log(printAstNode(node))
        }

    }

    getNode(): AstNode {
        const p1 = this.lex.peek()
        const kwd = p1.getKwd()
        if (kwd == 'package') {
            return this.parsePackageDecl()
        } else if (kwd == 'import') {
            return this.parseImportDecl()
        }

        throw new Error(`Unkown type: ${kwd}`)
    }

    private parsePackageDecl(): PackageDecl {
        const start = this.lex.getTokPos()
        this.lex.expect('package')
        const n1 = this.lex.expect('ID')
        return {
            kind: 'PackageDecl', name: n1.value,
            span: { start, end: this.lex.getTokPos() }
        }
    }

    private parseImportDecl(): ImportDecl {
        const start = this.lex.getTokPos()
        this.lex.expect('import')
        let is_pub = false
        if (this.lex.peek().getKwd() === 'pub') {
            is_pub = true
            this.lex.expect('pub')
        }
        this.lex.expect("STR_START")
        const n1 = this.lex.expect('STR_PART')
        this.lex.expect('STR_END')
        let alias = undefined as string | undefined
        if (this.lex.peek().getKwd() === 'as') {
            this.lex.expect('as')
            alias = this.lex.expect('ID').value
        }
        return {
            kind: 'ImportDecl', is_pub, alias, path: n1.value,
            span: { start, end: this.lex.getTokPos() }
        }
    }
}