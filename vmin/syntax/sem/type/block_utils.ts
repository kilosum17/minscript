import type { BlockDecl, Expr } from "../../parser/ast_types";
import { printAstNode } from "../../parser/ast_utils";
import { getExpType } from "./scope_get_exp_type";
import type { SemScope } from "./SemScope";

export function getBlockType(scope: SemScope, block: BlockDecl) {
    if (block.items.length == 0) {
        return undefined
    }
    const res = getExpType(scope, block.items.at(-1)! as Expr)
    // console.log('Block type', printAstNode(block), res)
    return res
}
