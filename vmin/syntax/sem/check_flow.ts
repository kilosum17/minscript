import type { AstNode, BlockDecl, FuncDecl } from "../parser/ast_types";
import { Diagnostic } from "./diagnostics";

export class CheckFlow {
    diagnostics: Diagnostic[] = []

    constructor(private nodes: AstNode[]) {

    }

    runChecks() {
        if (this.nodes.at(0)?.kind != 'PackageDecl') {
            this.diagnostics.push(new Diagnostic(
                'PACKAGE_AT_THE_VERY_TOP',
                { start: 0, end: 2 },
                ''
            ))
        }
        let packageDecls = this.nodes.filter(n => n.kind == 'PackageDecl')
        if (packageDecls.length > 0) {
            packageDecls.forEach((p, idx) => {
                if (idx == 0) return
                this.diagnostics.push(new Diagnostic(
                    'DUPLICATE_PACKAGE_DECLARATION',
                    p.span,
                    ''
                ))
            })
        }

        for (const node of this.nodes) {
            this.checkFile(node)
        }
        
    }

    checkFile(node: AstNode) {
        if (node.kind == 'PackageDecl') {

        } else if (node.kind == 'ImportDecl') {

        } else if (node.kind == 'Binding') {

        } else if (node.kind == 'UnionDecl') {

        } else if (node.kind == 'AliasDecl') {

        } else if (node.kind == 'FuncDecl') {
            this.checkFun(node, false)
        } else if (node.kind == 'StructDecl') {
            for (const n of node.fields_list.fields) {
                if (n.kind === 'FuncDecl') {
                    this.checkFun(n, true)
                }
            }
        } else {
            this.diagnostics.push(new Diagnostic(
                'NOT_VALID_IN_TOP_LEVEL',
                node.span,
                node.kind,
            ))
        }
    }

    checkFun(node: FuncDecl, is_method = false) {
        node.params.forEach((p, idx) => {
            if (p.name == 'this' && !is_method) {
                this.diagnostics.push(new Diagnostic(
                    'THIS_ONLY_IN_METHODS',
                    node.span,
                    ``
                ))
            } else if (p.name === 'this' && idx !== 0) {
                this.diagnostics.push(new Diagnostic(
                    'THIS_MUST_COME_FIRST',
                    node.span,
                    `Found at: ${idx}`
                ))
            }
        })
        this.checkBlock(node.block)
    }

    checkBlock(node: BlockDecl, in_loop = false) {
        node.items.forEach((s, idx) => {
            if (s.kind == 'ForLoop') {
                this.checkBlock(s.block, true)
            }
            if (s.kind == 'Break' && !in_loop) {
                this.diagnostics.push(new Diagnostic(
                    "BREAK_OUTSIDE_LOOP",
                    s.span,
                    ''
                ))
            }
            if (s.kind == 'Continue' && !in_loop) {
                this.diagnostics.push(new Diagnostic(
                    "CONTINUE_OUTSIDE_LOOP",
                    s.span,
                    ''
                ))
            }

        })
    }

}
