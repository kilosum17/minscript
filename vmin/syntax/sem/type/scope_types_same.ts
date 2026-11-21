import type { BindingType } from "./symbol";

export function areTypesSame(a: BindingType, b: BindingType) {
    let aAst = a.ast_type, bAst = b.ast_type
    if (aAst?.mode === 'var' && bAst?.mode === 'var') {
        if (aAst.type_name === bAst.type_name) {
            return true
        }
    }
    return false
}