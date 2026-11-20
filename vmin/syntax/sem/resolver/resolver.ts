import type { AstNode, AstType, FuncDecl } from "../../parser/ast_types";
import { printAstType } from "../../parser/ast_utils";
import type { ScopeType } from "../utils/scope_type";
import { ResolveAdder } from "./resolve_adder";
import { Resolver2 } from "./resolver_2";
import { ResScope } from "./resolver_scope";
import { type ResolveType, type SemType } from "./resolver_types";
import { printSaveTypeKind, resTypeName } from "./resolver_utils";

export class Resolver {
    astNodes: AstNode[] = []
    parentScope: ScopeType | null = null
    f_scope = new ResScope()
    r2: Resolver2
    r_add: ResolveAdder

    constructor(
        public name: string
    ) {
        this.r2 = new Resolver2(this)
        this.r_add = new ResolveAdder(this)

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
        this.r_add.addAll(this.astNodes)
    }

    resolveFunc(func: FuncDecl) {
        let scope = new ResScope(this.f_scope)
        func.params.forEach(p => {
            if (p.mode == 'var') {
                scope.add({
                    ...p.type,
                    var_name: p.name, is_param: true,
                })
            }
        })
        for (const s of func.block.items) {
            if (s.kind == 'Binding') {
                console.log('Binding ', s.name)
                let inferedType = undefined as undefined | SemType
                if (s.expr) {
                    inferedType = scope.resExpr(s.expr)
                }

                if (s.type) {
                    if (inferedType && !this.r2.isSame(inferedType, s.type)) {
                        // error
                    }
                    scope.add({
                        ...s.type,
                        var_name: s.name || '',
                    } satisfies ResolveType)
                } else {
                    if (inferedType) {
                        scope.add({
                            ...inferedType,
                            var_name: s.name || '',
                        } satisfies ResolveType)

                    }
                }
                console.log(`${s.name}:${printAstType(s.type!)} Infered: ${resTypeName(inferedType!)}`)
            }
        }
    }

}