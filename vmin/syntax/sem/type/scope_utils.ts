import type { AstType } from "../../parser/ast_types";
import type { BindingType } from "./symbol";

export function getReturnType(type: BindingType | undefined): BindingType | undefined {
    if (type?.ast_type.mode === 'func') {
        const ret: AstType = type.ast_type.ret || { mode: 'var', type_name: 'void' }
        return { ast_type: ret }
    }
    return undefined
}

