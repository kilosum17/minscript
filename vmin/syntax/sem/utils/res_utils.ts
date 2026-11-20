import type { AstNode } from "../../parser/ast_types"

let cur_id = 1
export function getNodeId(node: AstNode | undefined) {
    if (!node) return -1
    const n = (node as any) as { _id: number }
    if (!n._id) n._id = (cur_id++)
    return n._id
}
