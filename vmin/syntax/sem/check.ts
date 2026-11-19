import { readdir } from "node:fs/promises";
import type { AstNode } from "../parser/ast_types";
import { MsFile } from "./utils/file";
import path from "node:path";
import { Diagnostic } from "../utils/diagnostics";
import { CheckTypes } from "./resolve/check_types";
import { printDiag, printDiags } from "../utils/diag_utils";
import { getPreludeScope } from "./utils/prelude_types";


export class Checker {
    ast: AstNode[][] = []
    files: MsFile[] = []

    constructor(
        public packagePath: string
    ) {

    }

    async runCheck(loadedText?: Record<string, string>): Promise<Diagnostic[]> {
        const prelude = await getPreludeScope()
        // return []
        const entries = await readdir(this.packagePath, { withFileTypes: true });

        for (const entry of entries) {
            console.log(entry.name, entry.isDirectory() ? "[Folder]" : "[File]");
            if (entry.isDirectory()) continue

            if (!entry.name.endsWith('.ms')) continue
            if (entry.name.endsWith('_test.ms')) continue

            const fullpath = path.join(entry.parentPath, entry.name)
            const file = new MsFile(fullpath)
            this.files.push(file)
        }

        const res = await Promise.allSettled(this.files.map(async (p) => {
            if (loadedText?.[p.path]) {
                p.text = loadedText[p.path]!
                console.info('Skipped', p.path, p.text.substring(0, 10))
            } else {
                await p.read()
                console.log("after-read", p.text.substring(0, 20))
            }
            await p.parse()
        }))
        // console.log('reads', res, this.files.map(f => f.nodes.length))

        const check_type = new CheckTypes(
            this.packagePath,
            this.files,
        )
        check_type.runChecks(prelude)

        this.files.forEach(f => {
            printDiags(f.diags)
        })

        return this.files.flatMap(f => {
            return f.diags.map(d => {
                d.filepath = f.path
                return d
            })
        })
    }
}



