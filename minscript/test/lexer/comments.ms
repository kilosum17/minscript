package lexer_comments

/// Doc comment attached to `documented`.
/// Second doc line.
fun documented() {}

// line comment at top level

/* block comment */

/* block comment
   spanning lines
   with a nested /* inner /* deeper */ still inner */ comment
   still inside the outer comment
*/

fun main() {
    let a = 1 /* inline block */ + 2       // trivia between tokens: ws_before = true on `+`
    let b = 1/*glued*/+2                    // comment counts as whitespace: ws_before = true on `+`
    let url = "http://not-a-comment.com"    // `//` inside a string is not a comment
    let path = "/* not a comment */"
    let div = 10 / 2 / 1                    // single `/` is division
    // let disabled = 1
    let c = 3 // trailing comment; the newline still terminates the statement
    let d =   // comment after a continuation token: statement continues
        4
}
