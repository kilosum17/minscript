package parser_or_nullish

import "std.fs"
import "std.json"

// `or` keyword: unwrap, or evaluate RHS and RETURN it from the enclosing function
async fun load_config(path: string) -> Result[Config, string] {
    let bytes = await fs.read_file(path) or Err("IO failed: ${it}")
    let prefix = get_env_prefix() or Err("missing prefix")      // Option: no `it`
    let config = json.parse.[Config](bytes) or e => Err(e.to_str())
    let checked = validate(config) or e => {
        log.println("invalid config: ${e}")
        Err(e)
    }
    let explicit = maybe() or return Err("explicit return")
    let multi_line = compute_something()
        or Err("newline before `or` continues the statement")
    Ok(checked)
}

fun loops(lines: &mut Lines) {
    for {
        let line = lines.next() or break
        let parsed = line.to_int() or continue
        log.println(parsed)
    }
}

fun void_or() {
    let user = find_user(1) or {
        log.println("not found")
        return
    }
    let x = get() or return
}

// `?` propagation
fun propagate() -> Result[int, string] {
    let a = parse_a()?
    let b = (await_free_call()?).value
    Ok(a + b)
}

// `??` (lazy fallback) and `.or()` (method)
fun fallbacks(user: User?, cfg: &Config) {
    let name = user?.profile?.name ?? "anonymous"
    let port = env.get("PORT")?.to_int() ?? 8080
    let token = cache.get(key) ?? fetch_token()             // fetch_token() runs only on a miss
    let first = a ?? b ?? c ?? "none"
    let email = raw_email.or("guest@minscript.dev")
    let lazy = cfg.timeout.or(#{ compute_default() })

    var slot: int? = nil
    slot ??= 5
}

// truthiness: bool, Option, Result in conditions and with && || !
fun truthy(res: Result[User, string], opt: int?, flag: bool) {
    if res { log.println("ok") }
    if !opt { log.println("absent") }
    if opt && flag { log.println("both") }
    if res || opt { log.println("either") }
    for opt { break }
    let both = !res && !opt
}
