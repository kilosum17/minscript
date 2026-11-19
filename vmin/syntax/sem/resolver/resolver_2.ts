import type { AstType } from "../../parser/ast_types"
import type { Resolver } from "./resolver"
import type { ResolvedTypeKind } from "./resolver_types"


export class Resolver2 {

    constructor(
        public res: Resolver
    ) { }

    isSame(a: ResolvedTypeKind, b: ResolvedTypeKind | AstType) {
        return false
    }

}