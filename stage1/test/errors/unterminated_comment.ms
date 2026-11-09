package errors_unterminated_comment

fun main() {
    let x = 1
}

/* this block comment never closes            //~ E_UNTERMINATED_COMMENT
   /* the nested one does */
   but the outer one runs to EOF
