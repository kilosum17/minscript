"import "

import { lexer } from "./lexer/lexer";
import { Parser } from "./parser/parser";

async function main(path: string) {
    const file = Bun.file(path);
    const text = await file.text();
    lexer.tokenize(text)
    lexer.tokens.forEach(t => {
        // console.log(t.print())
    })

    console.log(lexer.tokens.slice(0, 400).map(s => s.val))
    // const parser = new Parser(lexer)


}

const path = process.argv[2]
console.log(process.argv)

main(path)

