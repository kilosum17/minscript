import { readdir } from "node:fs/promises";

export class Checker {
    constructor(
        public path: string
    ) {

    }

    async runCheck() {
        const entries = await readdir(this.path, { withFileTypes: true });

        for (const entry of entries) {
            console.log(entry.name, entry.isDirectory() ? "[Folder]" : "[File]");
        }
    }
}
