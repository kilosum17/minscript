import type { AstType } from "../../parser/ast_types"
import type { Resolver } from "./resolver"
import type { SemType } from "./resolver_types"


export class Resolver2 {

    constructor(
        public res: Resolver
    ) { }

    isSame(a: SemType, b: SemType | AstType) {
        return false
    }

}