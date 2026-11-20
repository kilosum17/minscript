import type { AstNode } from "../../parser/ast_types";

export function walkAstTree(n: AstNode[] | AstNode | undefined, pos: number): AstNode | undefined {
    if (!n) return undefined

    if (Array.isArray(n)) {
        for (const node of n) {
            const res = walkAstTree(node, pos)
            if (res) return res
        }
        return undefined
    }
    if (n.kind == 'FuncDecl') {
        console.log("in: ", n.name)
        return walkAstTree(n.block, pos)
    }
    if (n.kind === 'BlockDecl') {
        return walkAstTree(n.items, pos)
    }
    if (n.kind == 'Binding') {
        console.log("check: ", n.name?.text, `${n.span.start}:${n.span.end}`, pos, n.span.start <= pos && n.span.end >= pos)
        return walkAstTree(n.name, pos)
    }
    if (n.kind == 'Binary') {
        if (n.oper == '=') {
            return walkAstTree(n.lhs, pos)
        }
    }
    if (n.kind == 'Call') {
        return walkAstTree(n.lhs, pos)
    }

    if (n.span) {
        if (n.span.start <= pos && n.span.end >= pos) {
            return n
        }
    }

    return undefined
}

