import type { AstNode, BindingDecl, BlockDecl, ForLoopDecl, FuncDecl, StmtDecl } from "../../parser/ast_types";
import { printAstNode } from "../../parser/ast_utils";
import { getIterItemType } from "./generic_utils";
import { getExpType } from "./scope_get_exp_type";
import { printBinding } from "./scope_utils";
import { TODO } from "./sem_utils";
import { SemScope } from "./SemScope";
import type { Binding } from "./symbol";

export class SemAnalysis {
    file_scope: SemScope

    constructor() {
        this.file_scope = new SemScope()
    }

    analyze(
        astNodes: AstNode[],
    ) {
        this.file_scope = new SemScope()
        this.file_scope.addTypesFromNodes(astNodes)

        for (const node of astNodes) {
            if (node.kind == 'FuncDecl') {
                this.handleFunc(this.file_scope, node)
            }
        }
    }

    handleFunc(file_scope: SemScope, func: FuncDecl) {
        const funcScope = new SemScope(file_scope)
        func.params.forEach(p => {
            if (p.mode == 'var') {
                const bind: Binding = {
                    var_name: p.name,
                    ast_type: p.type,
                }
                funcScope.addBinding(bind)
            } else {
                TODO('Unhandled param types:', p)
            }
        })
        this.handleBlock(funcScope, func.block)
    }

    handleBlock(scope: SemScope, block: BlockDecl) {
        for (const stmt of block.items) {
            if (stmt.kind === 'Binding') {
                this.handleBinding(scope, stmt)
            } else if (stmt.kind === 'ForLoop') {
                this.handleForLoop(scope, stmt)
            }
        }
    }

    handleBinding(scope: SemScope, binding: BindingDecl) {
        if (binding.type) {
            if (binding.name) {
                const bind: Binding = {
                    var_name: binding.name.text,
                    ast_type: binding.type,
                    is_shared: binding.is_shared,
                }
                scope.addBinding(bind)
            }
        } else if (binding.name) {
            if (!binding.expr) TODO('Binding with out type and init', binding)
            const exprType = getExpType(scope, binding.expr)!
            const bind: Binding = {
                ...exprType,
                var_name: binding.name.text,
            }
            scope.addBinding(bind)
        } else if (binding.bind_expr) {
            if (binding.bind_expr.kind == 'TupleInit') {
                const exprType = getExpType(scope, binding.expr!)
                // console.log('Got type', exprType)
                const astType = exprType?.ast_type
                if (astType?.mode !== 'tuple') TODO('Expresion not returning tuple', exprType)

                binding.bind_expr.items.forEach((tuple_item, idx) => {
                    if (tuple_item.kind != 'Var') TODO('Unexpected tuple item kind', tuple_item)
                    const bind: Binding = {
                        var_name: tuple_item.name,
                        ast_type: astType.items[idx]!,
                        type_id: exprType?.type_id,
                        init_expr: binding.expr,
                        tuple_pos: idx,
                    }
                    scope.addBinding(bind)
                })

            }
        } else if (binding.name) {

        }
    }

    handleForLoop(funcScope: SemScope, forNode: ForLoopDecl) {
        const forScope = new SemScope(funcScope)
        if (forNode.mode == 'in') {
            const iterType = getExpType(forScope, forNode.expr)
            if (!iterType) TODO('in expected iterator', iterType, printAstNode(forNode))
            const itemType = getIterItemType(forScope, iterType)
            console.log('Iter', forNode.var_name, itemType)
            if (itemType) {
                const bind: Binding = {
                    var_name: forNode.var_name,
                    ...itemType,
                }
                forScope.addBinding(bind)
            }
        }
        this.handleBlock(forScope, forNode.block)
    }

}