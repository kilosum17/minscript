"import "

import { lexer } from "./lexer/lexer";

async function main(path: string) {
    const file = Bun.file(path);
    const text = await file.text();
    lexer.tokenize(text)
    lexer.tokens.forEach(t => {
        console.log(t.print)
    })

}

const path = process.argv[2]
console.log(process.argv)

main(path)

