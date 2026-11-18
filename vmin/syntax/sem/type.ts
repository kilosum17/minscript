import path_ from 'node:path'
import type { AliasDecl, AstNode, FuncDecl, StructDecl, UnionDecl } from '../parser/ast_types'

export type SemType = (
    | FuncDecl | UnionDecl | AliasDecl
    | StructDecl
) & { file: string }

export class TypeScope {
    name: string = ''
    types = [] as SemType[]

    constructor(
        public path: string,
        public parent?: TypeScope,
    ) {
        this.name = path_.basename(path)
    }

    addAll(nodes: AstNode[], file: string | null) {
        nodes.forEach(n => this.addType(n, file))
    }

    addType(node: AstNode, file: string | null) {
        if (node.kind == 'FuncDecl' || node.kind == 'UnionDecl' ||
            node.kind == 'AliasDecl' || node.kind === 'StructDecl'
        ) {
            this.types.push({ ...node, file: file || this.path })
        }
    }

}