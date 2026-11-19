import { Diagnostic } from "../utils/diagnostics"
import { dirname } from "node:path"
import { Checker } from "./check"
import { findFile } from "./utils/file"

export async function lspCheck({ text, path }: {
    text: string, path: string
}): Promise<Diagnostic[]> {
    const diags = [] as Diagnostic[]

    diags.push(new Diagnostic(
        'BREAK_OUTSIDE_LOOP',
        { start: 10, end: 14 },
        'Not allowed as test',
    ))

    console.log('Got check', text?.substring(0, 10), 'path:', path)

    try {
        // const text = readFile(path, 'utf-8')
        const dir_path = dirname(path)
        const checker = new Checker(dir_path)
        await checker.runCheck({ [path]: text })
        console.log(checker.files)
        console.log('At path', findFile(checker.files, path)?.path)
        return findFile(checker.files, path)?.diags || []
    } catch (e) {
        console.warn('Error', e)
    }
    return diags

}


