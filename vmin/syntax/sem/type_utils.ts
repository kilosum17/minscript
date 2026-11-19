import { printAstType } from "../parser/ast_utils";
import type { TypeScope } from "./type";

export function printScope(scope: TypeScope) {
    return scope.types.map(t => printAstType(t)).join('\n')
}
