import type { AstNode, AstSpan } from "../../parser/ast_types";
import { printBinding } from "./scope_utils";
import { getId } from "./sem_utils";
import type { Binding, TypeDecl } from "./symbol";

export class SemScope {
    type_decls: TypeDecl[] = []
    bindings: Binding[] = []
    children: SemScope[] = []
    span: AstSpan = { start: 0, end: 0 }
    tag = ''

    constructor(
        public parent?: SemScope,
        public id: number = getId(),
    ) {
        if (parent) {
            parent.addChild(this)
        }
    }

    addChild(child: SemScope) {
        this.children.push(child)
    }

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