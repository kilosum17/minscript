import type { MsFile } from "./file";
import { Diagnostic } from "../utils/diagnostics";
import { TypeScope } from "./type";
import type { FuncDecl, StructDecl } from "../parser/ast_types";
import { file } from "bun";
import { getPreludeScope } from "./prelude_types";



export class CheckTypes {

    constructor(
        public packagePath: string,
        public files: MsFile[]
    ) {

    }

    runChecks(prelude: TypeScope | undefined) {
        if (this.files.length == 0) return
        const package_names = this.files
            .map(f => f.nodes.at(0))
            .filter(f => f?.kind == 'PackageDecl')
            .map(f => f.name)
        const unique_name = new Set(package_names)
        const no = unique_name.size
        console.log('Files', this.files.map(f => `${f.path}:${f.nodes.length}`))

        if (no > 1) {
            this.files.forEach(f => {
                if (f.nodes.length == 0) return
                f.diags.push(new Diagnostic(
                    "MULTIPLE_PACKAGE_NAMES",
                    f.nodes.at(0)!.span,
                    `Mutiple package names ${[...unique_name].join(',')}`
                ))
            })
        }

        const packageScope = new TypeScope(this.packagePath, prelude)
        this.files.forEach(f => {
            packageScope.addAll(f.nodes, f.path)
        })

        this.files.forEach(f => {
            this.checkFile(f, packageScope)
        })

    }

    private checkFile(file: MsFile, packageScope: TypeScope) {
        const fileScope = new TypeScope(file.path, packageScope)
        fileScope.addAll(file.nodes, null)

        file.nodes.forEach(n => {
            if (n.kind === 'FuncDecl') {
                this.checkFunc({ func: n, fileScope })
            }
            if (n.kind == 'StructDecl') {
                n.fields_list.fields.forEach(f => {
                    if (f.kind == 'FuncDecl') {
                        this.checkFunc({ func: f, fileScope, struct: n })
                    }
                })
            }
            if (n.kind == 'UnionDecl') {

            }
        })
    }

    private checkFunc({ func, fileScope, struct }: {
        func: FuncDecl, fileScope: TypeScope, struct?: StructDecl
    }) {

    }

}
