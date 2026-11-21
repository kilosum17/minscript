import type { AstNode } from "../../parser/ast_types";
import { printBinding } from "./scope_utils";
import { getId } from "./sem_utils";
import type { Binding, TypeDecl } from "./symbol";

export class SemScope {
    type_decls: TypeDecl[] = []
    bindings: Binding[] = []

    constructor(
        public parent?: SemScope,
        public id: number = getId(),
    ) { }

    addTypesFromNodes(nodes: AstNode[]) {
        nodes.forEach(node => {
            if (node.kind == 'FuncDecl' || node.kind == 'StructDecl' || node.kind === 'AliasDecl' || node.kind == 'UnionDecl') {
                this.type_decls.push({
                    ...node,
                    type_id: getId(),
                })
            }
        })
    }

    addBinding(bind: Binding) {
        this.bindings.push(bind)
        console.log(`Add `, printBinding(this, bind))
    }

}