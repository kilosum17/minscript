import type { AstNode, FuncDecl } from "../../parser/ast_types";
import { printAstType } from "../../parser/ast_utils";
import type { ScopeType } from "../utils/scope_type";
import { Resolver2 } from "./resolver_2";
import { ResScope } from "./resolver_scope";
import type { ResolvedTypeKind } from "./resolver_types";
import { printSaveTypeKind } from "./resolver_utils";

export class Resolver {
    astNodes: AstNode[] = []
    parentScope: ScopeType | null = null
    f_scope = new ResScope()
    r2: Resolver2

    constructor(
        public name: string
    ) {
        this.r2 = new Resolver2(this)

    }

    resolve(
        astNodes: AstNode[],
        parentScope: ScopeType | null,
    ) {
        this.astNodes = astNodes
        this.parentScope = parentScope
        this.f_scope.clear()

        this.resolveRoot()
    }

    resolveRoot() {
        this.astNodes.forEach(n => {
            if (n.kind == 'StructDecl') {
                this.f_scope.add({
                    name: n.name, is_pub: n.is_pub,
                    mode: {
                        kind: 'Struct', decl: n,
                    }
                })
            }
            if (n.kind == 'FuncDecl') {
                this.f_scope.add({
                    name: n.name, is_pub: n.is_pub,
                    mode: { kind: 'Func', decl: n },
                })
                this.resolveFunc(n,)
            }

        })
    }

    resolveFunc(func: FuncDecl) {
        let scope = new ResScope(this.f_scope)
        func.params.forEach(p => {
            if (p.mode == 'var') {
                scope.add({
                    name: p.name, is_param: true,
                    mode: { kind: 'Var', type: p.type, }
                })
            }
        })
        for (const s of func.block.items) {
            if (s.kind == 'Binding') {
                console.log('Binding ', s.name)
                let inferedType = undefined as undefined | ResolvedTypeKind
                if (s.expr) {
                    inferedType = scope.resExpr(s.expr)
                }

                if (s.type) {
                    if (inferedType && !this.r2.isSame(inferedType, s.type)) {
                        // error
                    }
                    scope.add({
                        name: s.name || '',
                        mode: { kind: 'Var', type: s.type }
                    })
                } else {
                    if (inferedType) {
                        scope.add({
                            name: s.name || '',
                            mode: inferedType
                        })

                    }
                }
                console.log(`${s.name}:${printAstType(s.type!)} Infered: ${printSaveTypeKind(inferedType)}`)
            }
        }
    }

}