import type { Expr } from "../../parser/ast_types";
import { getTypeOf } from "./scope_get_type_of";
import { getReturnType } from "./scope_utils";
import { TODO } from "./sem_utils";
import type { SemScope } from "./SemScope";
import type { BindingType } from "./symbol";

export function getExpType(scope: SemScope, e: Expr): BindingType | undefined {
    if (e.kind === 'Call') {
        if (e.lhs.kind !== 'Var') TODO('Function call without Var type', e)
        return getReturnType(getTypeOf(scope, e.lhs.name))
    }
    // if(e.)
    if (e.kind == 'Literal') {
        if (e.mode == 'BOOL') {
            return { ast_type: { mode: 'var', type_name: 'bool' } }
        }
        if (e.mode == 'CHAR') {
            return { ast_type: { mode: 'var', type_name: 'char' } }
        }
        if (e.mode == 'BYTE') {
            return { ast_type: { mode: 'var', type_name: 'byte' } }
        }
        if (e.mode == 'NUM') {
            if (e.val.includes('.')) {
                return { ast_type: { mode: 'var', type_name: 'int' } }
            } else {
                return { ast_type: { mode: 'var', type_name: 'f64' } }
            }
        }
    }
    if (e.kind == 'Binary') {

    }

}