import { readdir } from "node:fs/promises";
import type { AstNode } from "../parser/ast_types";
import { File } from "./file";
import path from "node:path";
import { Diagnostic } from "./diagnostics";


export class Checker {
    ast: AstNode[][] = []
    files: File[] = []
    diagnostics: Diagnostic[] = []

    constructor(
        public path: string
    ) {

    }

    async runCheck() {
        const entries = await readdir(this.path, { withFileTypes: true });

        for (const entry of entries) {
            console.log(entry.name, entry.isDirectory() ? "[Folder]" : "[File]");
            if (entry.isDirectory()) continue

            if (!entry.name.endsWith('.ms')) continue
            if (entry.name.endsWith('_test.ms')) continue

            const fullpath = path.join(entry.parentPath, entry.name)
            const file = new File(fullpath)
            this.files.push(file)
        }

        const res = await Promise.allSettled(this.files.map(p => p.parse()))
        console.log('reads', res, this.files.map(f => f.nodes.length))

    }
}



