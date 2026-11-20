import type { AstNode, FuncDecl } from "../../parser/ast_types";
import { printAstType } from "../../parser/ast_utils";
import { getNodeId } from "../utils/res_utils";
import { ResolveAdder } from "./resolve_adder";
import { Resolver2 } from "./resolver_2";
import { ResScope } from "./resolver_scope";
import { type ResolveType, type SemType } from "./resolver_types";
import { resTypeName } from "./resolver_utils";

export class Resolver {
    astNodes: AstNode[] = []
    parentScope: ResScope | null = null
    f_scope = new ResScope()
    r2: Resolver2
    r_add: ResolveAdder
    scopes = {} as Record<number, ResScope>
    symbols = {} as Record<number, ResolveType>
    symbolMap = {} as Record<number, AstNode | undefined>

    constructor(
        public name: string
    ) {
        this.r2 = new Resolver2(this)
        this.r_add = new ResolveAdder(this)

    }

    resolve(
        astNodes: AstNode[],
        parentScope: ResScope | null,
    ) {
        this.astNodes = astNodes
        this.f_scope.parent = parentScope || undefined
        this.f_scope.clear()

        this.resolveRoot()
    }

    resolveRoot() {
        this.r_add.addAll(this.astNodes)
        const symbs = Object.entries(this.symbols).map(e => {
            const id = Number(e[0])
            let name = '--'
            const node = this.symbolMap[id]
            if (node?.kind == 'NameDecl') {
                name = node.text
            }
            return [id, name, resTypeName((e[1]))]
        })
        console.log('Resolved', symbs)
    }

    addScope(node: AstNode, scope: ResScope) {
        this.scopes[getNodeId(node)] = scope
    }

    addSymbol(node: AstNode | undefined, resType: ResolveType) {
        const id = getNodeId(node)
        this.symbols[id] = resType
        this.symbolMap[id] = node
    }

    resolveFunc(func: FuncDecl) {
        let scope = new ResScope(this.f_scope)
        this.addScope(func, scope)

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
                console.log('Binding ', s.name?.text)
                let inferedType = undefined as undefined | SemType
                if (s.expr) {
                    inferedType = scope.resExpr(s.expr)
                }

                if (s.type) {
                    if (inferedType && !this.r2.isSame(inferedType, s.type)) {
                        // error
                    }
                    const resType = {
                        ...s.type,
                        var_name: s.name?.text || '',
                    } satisfies ResolveType
                    this.addSymbol(s?.name, resType)
                    scope.add(resType)
                } else {
                    if (inferedType) {
                        const resType = {
                            ...inferedType,
                            var_name: s.name?.text || '',
                        } satisfies ResolveType
                        this.addSymbol(s?.name, resType)
                        scope.add(resType)
                    }
                }
                console.log(`${s.name?.text}:${printAstType(s.type!)} Infered: ${resTypeName(inferedType!)}`)
            }
        }
    }

}