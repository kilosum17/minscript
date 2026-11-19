import type { MsFile } from "../utils/file";
import { Diagnostic } from "../../utils/diagnostics";
import { ScopeType } from "../utils/scope_type";
import type { BindingDecl, FuncDecl, StructDecl } from "../../parser/ast_types";

export class CheckTypes {

    constructor(
        public packagePath: string,
        public files: MsFile[]
    ) {

    }

    runChecks(prelude: ScopeType | undefined) {
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

        const packageScope = new ScopeType(this.packagePath, prelude)
        this.files.forEach(f => {
            packageScope.addAll(f.nodes)
        })

        this.files.forEach(f => {
            this.checkFile(f, packageScope)
        })

    }

    private checkFile(file: MsFile, packageScope: ScopeType) {
        const fileScope = new ScopeType(file.path, packageScope)
        fileScope.addAll(file.nodes)

        file.nodes.forEach(n => {
            if (n.kind === 'FuncDecl') {
                this.checkFunc({ file, func: n, fileScope })
            }
            if (n.kind == 'StructDecl') {
                n.fields_list.fields.forEach(f => {
                    if (f.kind == 'FuncDecl') {
                        this.checkFunc({ file, func: f, fileScope, struct: n })
                    }
                })
            }
            if (n.kind == 'UnionDecl') {

            }
        })

    }

    private checkFunc({ file, func, fileScope, struct }: {
        file: MsFile, func: FuncDecl, fileScope: ScopeType, struct?: StructDecl
    }) {
        for (const item of func.block.items) {
            if (item.kind == 'Binding') {

            }
        }
    }

    private resolveBinding({ file, scope, binding }: {
        file: MsFile, scope: ScopeType, binding: BindingDecl
    }) {
        if (binding.expr) {
            // binding.
        }
        if (binding.name) {
            if (binding.type) {
                // file.types[binding] = 9
            }
        }
    }

}
