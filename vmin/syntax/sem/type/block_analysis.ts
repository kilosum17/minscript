import type { AstNode, BindingDecl, BlockDecl, ForLoopDecl, FuncDecl, StructDecl } from "../../parser/ast_types"
import { printAstNode } from "../../parser/ast_utils"
import { handleIf } from "./expr_analysis"
import { getIterItemType } from "./generic_utils"
import { getExpType } from "./scope_get_exp_type"
import { getScopeName } from "./scope_get_type_of"
import { TODO } from "./sem_utils"
import { SemScope } from "./SemScope"
import type { Binding } from "./symbol"

export function handleBlock(scope: SemScope, block: BlockDecl) {
    for (const stmt of block.items) {
        handleBlockItem(scope, stmt)
    }
}

export function handleBlockItem(scope: SemScope, stmt: AstNode) {
    if (stmt.kind === 'Binding') {
        handleBinding(scope, stmt)
    } else if (stmt.kind === 'ForLoop') {
        handleForLoop(scope, stmt)
    } else if (stmt.kind == 'If') {
        handleIf(scope, stmt)
    }
}

export function handleFunc(file_scope: SemScope, func: FuncDecl) {
    console.log(`\n>> Resolve fn ${func.name}`)
    const funcScope = new SemScope(file_scope)
    funcScope.span = { ...func.span }
    funcScope.span.end = func.block.span.end
    funcScope.tag = `FN ${func.name}`

    func.params.forEach(p => {
        if (p.mode == 'var' || p.mode == 'variadic') {
            const bind: Binding = {
                var_name: p.name,
                ast_type: p.type,
            }
            funcScope.addBinding(bind)
        } else if (p.mode == 'receiver') {
        } else {
            TODO('Unhandled param types:', p)
        }
    })
    handleBlock(funcScope, func.block)
}

export function handleBinding(scope: SemScope, binding: BindingDecl) {
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

export function handleForLoop(funcScope: SemScope, forNode: ForLoopDecl) {
    const forScope = new SemScope(funcScope)
    forScope.span = { ...forNode.span }
    forScope.span.end = forNode.block.span.end
    forScope.tag = `ForLoop`

    if (forNode.mode == 'in') {
        const iterType = getExpType(forScope, forNode.expr)
        if (!iterType) TODO('in expected iterator', iterType, printAstNode(forNode))
        const itemType = getIterItemType(forScope, iterType)
        // console.log('Iter', forNode.var_name, itemType)
        if (itemType) {
            forScope.tag = `ForLoop ${forNode.var_name}`
            const bind: Binding = {
                var_name: forNode.var_name,
                ...itemType,
            }
            forScope.addBinding(bind)
        }
    }
    handleBlock(forScope, forNode.block)
}

export function handleStruct(fileScope: SemScope, node: StructDecl) {
    console.log(`\n>> Resolve struct ${node.name}`)
    const scope = new SemScope(fileScope)
    scope.span = { ...node.span }
    scope.span.end = node.fields_list.span.end

    scope.tag = `Struct ${node.name}`

    const thisName = getScopeName(fileScope, node.name)
    // console.log('this', thisName)
    const thisBind: Binding = {
        var_name: 'this',
        ...thisName,
        ast_type: null,
    }
    scope.addBinding(thisBind)
    node.fields_list.fields.forEach(f => {
        if (f.kind === 'FuncDecl') {
            handleFunc(scope, f)
        }
    })
    // if (node.name === 'Point2') throw TODO('Done')

}