import { isExpr } from "../../parser/ast_help";
import type { BlockDecl, Expr, StmtDecl } from "../../parser/ast_types";
import { handleBlock, handleBlockItem } from "./block_analysis";
import { SemScope } from "./SemScope";

export function handleIf(blockScope: SemScope, ifNode: Expr) {
    if (ifNode.kind !== 'If') return
    const thenScope = new SemScope(blockScope)
    thenScope.span = ifNode.span

    if (ifNode.is_let) {

    }

    handleBlock(thenScope, ifNode.then)

    if (ifNode.else) {
        if (isExpr(ifNode.else)) {
            handleBlockItem(blockScope, ifNode.else as Expr)
        } else {
            const elseScope = new SemScope(blockScope)
            elseScope.span = ifNode.else.span
            handleBlock(elseScope, ifNode.else as BlockDecl)
        }
    }

}


