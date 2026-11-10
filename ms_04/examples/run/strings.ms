// Strings on the JS back end: lengths and offsets are UTF-8 bytes (spec §14.3), like on every back end.
package main

fn main() {
    let s = "héllo wörld 😀!"
    log.println("bytes, chars:", s.len(), s.chars().len(), s.bytes().len())
    log.println("find / substring:", s.find("w", 0) ?? -1, s.substring(0, 6), s.substring(7, 13))
    log.println("helpers:", "  ünï  ".trim(), "a,é,😀".split(","), "é😀".split(""), "naïve.enc".strip_suffix(".enc"))
    log.println("search:", s.contains("ö"), s.starts_with("hé"), s.ends_with("😀!"), s.replace("ö", "o"))
    log.println("to_int:", " -42 ".to_int().unwrap(), "4é".to_int().is_err(), "".to_int().is_err())
    log.println("bytes:", "aé".byte_at(1), recover { "aé".byte_at(5) }.is_err())
    let inside = recover { s.substring(0, 2) }       // byte 2 is inside "é"
    if let Err(p) = inside { log.println("cut inside a char:", p.kind) }
}
