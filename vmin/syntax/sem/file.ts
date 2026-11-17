import { Lexer } from "../lexer/lexer";
import type { AstNode } from "../parser/ast_types";
import { Parser } from "../parser/parser";

export class File {
    nodes = [] as AstNode[]

    constructor(
        public path: string
    ) {
    }

    async parse() {
        try {
            const text = await Bun.file(this.path).text()
            const lexer = new Lexer(text)
            lexer.tokenize()
            const parser = new Parser(lexer)
            parser.parse()
            this.nodes = parser.nodes
        } catch (e) {
            console.error(`Parsing: ${this.path} failed`, e)
        }
    }

}