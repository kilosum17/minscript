package lexer_strings

fun main() {
    let empty = ""
    let plain = "hello"
    let escapes = "dq \" bs \\ nl \n tab \t cr \r nul \0 dollar \$ sq \' hex \x41 uni \u{1F600}"

    // interpolation: the lexer keeps a mode stack (string ↔ interpolation, with brace depth)
    let interp = "Hello ${user.name}, id=${user.id}"
    let interp_expr = "sum=${a + b * 2}"
    let interp_call = "v=${format(compute(1, 2), "x")}"          // string nested inside ${}
    let interp_nested = "outer ${ "inner ${deep} end" } done"    // interpolation nested twice
    let interp_braces = "rec=${ r{ a: 1 }.a } len=${ m{ "k": 1 }.len() }"   // braces inside ${} don't close it
    let interp_closure = "n=${ items.map(#{ it * 2 }).len() }"
    let adjacent = "${a}${b}${c}"
    let escaped_dollar = "price: \${amount}"   // literal text, not interpolation
    let lone_dollar = "costs $5 and ${x}"      // `$` not followed by `{` is literal

    // multi-line: first newline dropped, common indentation (from the closing line) stripped
    let multi = """
        first line
        second: ${user.name}
          indented two more
        """
    let multi_one_line = """single line "quotes" allowed"""

    // raw: no escapes, no interpolation, may span lines
    let raw = r"C:\users\name\file.txt"
    let raw_multi = r"line one
line two \n ${not_interpolated}"

    // characters
    let ch = 'a'
    let ch_nl = '\n'
    let ch_quote = '\''
    let ch_bs = '\\'
    let ch_uni = '\u{1F600}'
    let ch_digit = '1'          // char, not a tag (tagged records were removed)
}
