import type { File } from "./file";
import { Diagnostic } from "../utils/diagnostics";
import { TypeScope } from "./type";
import type { FuncDecl } from "../parser/ast_types";



export class CheckTypes {

    constructor(
        public packagePath: string,
        public files: File[]
    ) {

    }

    runChecks() {
        if (this.files.length == 0) return
        const package_names = this.files
            .map(f => f.nodes.at(0))
            .filter(f => f?.kind == 'PackageDecl')
            .map(f => f.name)
        const unique_name = new Set(package_names)
        const no = unique_name.size
        console.log('NAmes', package_names, this.files.map(f => f.path))
        console.log('NAmes', this.files.map(f => f.nodes.at(0)?.kind))
        console.log('Files', this.files.map(f => `${f.path}${f.nodes.length}`))

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

        const packageScope = new TypeScope(this.packagePath)
        this.files.forEach(f => {
            packageScope.addAll(f.nodes, f.path)
        })

    }

    private checkFile(file: File, packageScope: TypeScope) {
        const fileScope = new TypeScope(file.path, packageScope)
        fileScope.addAll(file.nodes, null)

        file.nodes.forEach(n => {
            if (n.kind === 'FuncDecl') {
                this.checkFunc(n, fileScope)
            }
        })
    }

    private checkFunc(func: FuncDecl, fileScope: TypeScope) {
        
    }

}
