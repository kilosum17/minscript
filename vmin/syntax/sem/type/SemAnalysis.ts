import type { AstNode } from "../../parser/ast_types";
import { handleFunc, handleStruct } from "./block_analysis";
import { SemScope } from "./SemScope";

export class SemAnalysis {
    file_scope: SemScope

    constructor() {
        this.file_scope = new SemScope()
    }

    analyze(
        astNodes: AstNode[],
    ) {
        this.file_scope = new SemScope()
        this.file_scope.addTypesFromNodes(astNodes)

        for (const node of astNodes) {
            if (node.kind == 'FuncDecl') {
                handleFunc(this.file_scope, node)
            } else if (node.kind == 'StructDecl') {
                handleStruct(this.file_scope, node)
            }
        }
    }

}