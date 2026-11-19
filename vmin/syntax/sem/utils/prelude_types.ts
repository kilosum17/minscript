import { printAstNode } from "../../parser/ast_utils";
import { printDiags } from "../../utils/diag_utils";
import { CheckTypes } from "../resolve/check_types";
import { MsFile } from "./file";
import { ScopeType } from "./scope_type";
import { printScope } from "./type_utils";

let savedScope: ScopeType | null = null
let path = 'std/prelude.ms'

export async function getPreludeScope() {
    if (savedScope) return savedScope
    const file = new MsFile(path)
    await file.read()
    file.parse()
    if (file.diags.length > 0) {
        console.log('Prelude diags:', printDiags(file.diags))
        throw new Error("Prelude should be clean")
    }
    const checker = new CheckTypes('prelude', [file])
    checker.runChecks(undefined)
    if (file.diags.length > 0) {
        console.log('Prelude check diags:', printDiags(file.diags))
        throw new Error("Prelude should be clean")
    }
    const scope = new ScopeType(file.path)
    scope.addAll(file.nodes)
    console.log('Prelude Scope: ', printScope(scope))
    savedScope = scope
    return scope
}

