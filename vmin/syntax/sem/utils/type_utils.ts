import { printAstType } from "../../parser/ast_utils";
import type { BasicType, ScopeType } from "./scope_type";

export function printScope(scope: ScopeType) {

    const printBasic = (t: BasicType) => {
        return `${t.name}:${t.type_name}`
    }

    return scope.types.map(t => {
        if (t.kind == 'VarType') {
            let type = ''
            if (t.type.kind == 'BasicType') {
                type = printBasic(t.type)
            } else if (t.type.kind == 'VarType') {
                type = 'TODODD'
            } else {
                type = printAstType(t.type)
            }
            return `${t.name}:${type}`
        }
        if (t.kind == 'BasicType') {
            return printBasic(t)
        }
        return printAstType(t)
    }).join('\n')
    
}

