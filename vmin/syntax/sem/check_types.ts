import type { File } from "./file";
import { Diagnostic } from "../utils/diagnostics";



export class CheckTypes {
    diags: Diagnostic[] = []

    constructor(
        public files: File[]
    ) {

    }

    runChecks() {
        this.diags = []

        if (this.files.length == 0) return
        const package_names = this.files
            .map(f => f.nodes.at(0))
            .filter(f => f?.kind == 'PackageDecl')
            .map(f => f.name)
        const unique_name = new Set(package_names)
        const no = unique_name.size

        if (no > 1) {
            this.files.forEach(f => {
                if (f.nodes.length == 0) return
                this.diags.push(new Diagnostic(
                    "MULTIPLE_PACKAGE_NAMES",
                    f.nodes.at(0)!.span,
                    `Mutiple package names ${unique_name.values()}`
                ))
            })
        }

    }

}
