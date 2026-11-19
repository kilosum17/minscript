import { Lexer } from "../lexer/lexer";
import type { AstNode } from "../parser/ast_types";
import { Parser } from "../parser/parser";
import type { Diagnostic } from "../utils/diagnostics";
import fs from "node:fs/promises"

export class MsFile {
    nodes = [] as AstNode[]
    text = ''
    diags: Diagnostic[] = []

    constructor(
        public path: string
    ) {
    }

    async read() {
        this.text = await fs.readFile(this.path, 'utf8')
    }

    async parse() {
        try {
            const lexer = new Lexer(this.text)
            lexer.tokenize()
            const parser = new Parser(lexer)
            parser.parse()
            this.nodes = parser.nodes
        } catch (e) {
            console.error(`Parsing: ${this.path} failed`, e)
        }
    }

}

export function findFile(files: MsFile[], path: string) {
    return files.find(f => f.path === path)
}
