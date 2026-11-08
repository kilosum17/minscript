package utf8

import "std.testing.*"

fun test_round_trip() {
    let text = "héllo 😀"
    let bytes = encode(text)
    assert_eq(bytes.len(), 11)
    assert_eq(decode(bytes), text)
    assert_eq(decode_range(bytes, 1, 3), "é")
    assert_eq(decode_range(bytes, 7, 99), "😀")
}

fun test_invalid_bytes_decode_to_replacement() {
    let bad: Vec[u8] = [104, 255, 105]
    assert_eq(decode(bad), "h\u{FFFD}i")
}

fun test_sequence_length() {
    assert_eq(sequence_length(104), 1)
    assert_eq(sequence_length(0xc3), 2)
    assert_eq(sequence_length(0xf0), 4)
}
