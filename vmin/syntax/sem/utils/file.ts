import { Lexer } from "../../lexer/lexer";
import type { AstNode } from "../../parser/ast_types";
import { Parser } from "../../parser/parser";
import type { Diagnostic } from "../../utils/diagnostics";
import fs from "node:fs/promises"
import { ScopeType, type SemType } from "./scope_type";

export class MsFile {
    nodes = [] as AstNode[]
    text = ''
    diags: Diagnostic[] = []
    fileScope: ScopeType
    scopes = {} as Record<number, ScopeType>

    constructor(
        public path: string
    ) {
        this.fileScope = new ScopeType(path)
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

    setPackageScope(scope: ScopeType) {
        scope.parent = scope
        scope.addAll(this.nodes)
    }

    private cur_id = 0
    getId(node: AstNode): number {
        const n = (node as any) as { _id: number }
        if (n._id == undefined) {
            n._id = this.cur_id
            this.cur_id++
        }
        return n._id
    }

    getScope(id: number, parent?: ScopeType) {
        if (!this.scopes[id]) {
            this.scopes[id] = parent || new ScopeType(`func:${id}`, this.fileScope)
        }
        return this.scopes[id]
    }

}

export function findFile(files: MsFile[], path: string) {
    return files.find(f => f.path === path)
}
