import type { AstType } from "../../parser/ast_types";
import { TODO } from "./sem_utils";
import type { SemScope } from "./SemScope";
import type { BindingType } from "./symbol";

export function resolveGeneric(scope: SemScope, bindType: BindingType, astType: AstType) {
    if (bindType.type_hints) {
        return bindType.type_hints
    }
    if (astType?.mode === 'var') {
        const hints = astType.generics?.items
            .map(t => {
                let tt: AstType
                if (Array.isArray(t)) {
                    // if (t.length > 1) return false
                    tt = t[0]
                } else {
                    tt = t
                }
                // console.log('TT', tt)
                if (tt.mode != 'var') return false
                return tt.type_name
            })
            .filter(t => t !== false) || []
        // console.log('GetGen', astType.generics?.items, hints)
        return hints
    }
    return []
}

export function getIterItemType(scope: SemScope, type: BindingType): BindingType | undefined {
    if (type.ast_type?.mode == 'var') {
        if (
            type.ast_type.type_name === 'Vec' ||
            type.ast_type.type_name === 'Range' ||
            type.ast_type.type_name === 'Set'
        ) {
            const hints = resolveGeneric(scope, type, type.ast_type)
            if (hints.length === 0) {
                TODO('Iter expected alteast one type hint', hints, type)
            }
            return {
                ast_type: { mode: 'var', type_name: hints[0]! }
            }
        }
    }
    return undefined
}