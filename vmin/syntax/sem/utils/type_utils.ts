import { printAstType } from "../../parser/ast_utils";
import type { ScopeType } from "./scope_type";

export function printScope(scope: ScopeType) {
    return scope.types.map(t => {
        if (t.kind == 'VarType') {
            return `${t.name}:${printAstType(t.type)}`
        }
        if(t.kind=='BasicType'){
            return `${t.name}:${t.type_name}`
        }
        return printAstType(t)
    }).join('\n')
}

