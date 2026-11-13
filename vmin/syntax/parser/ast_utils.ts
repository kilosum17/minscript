import type { AstNode } from "./ast_types"

export function printAstNode(n: AstNode): string{
    switch (n.kind) {
        case "PackageDecl": {
            return `> package ${n.name}`
        }
        case "ImportDecl": {
            return `> import${n.is_pub ? ' pub' : ''} ${n.path}${n.alias ? ` as ${n.alias} ` : ''}`
        }
    }
}