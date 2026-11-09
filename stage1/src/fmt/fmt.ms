// The formatter (`ms fmt`, spec §17.8), ported from minscript/src/fmt.ts: prints a parsed file in the
// standard style.
//
// - Layout uses a small Wadler / Prettier document printer: a `group` goes on one line if it fits in
//   `max_width`, otherwise its `line`s become newlines. Breaks are only placed where spec §5.4 allows
//   them: inside `(…)` / `[…]`, after a binary operator, before `.`; inside `{…}` entries go one per
//   line (newlines separate them).
// - The author's choices are kept where the style has no opinion: a block, body, literal, `match` or
//   `select` written on several lines stays expanded; a broken method chain or a line break after a
//   binary operator stays broken. A one-liner stays one if it still fits.
// - Literals (strings, templates, numbers, chars) are copied from the source.
// - Comments between the entries of a list (items, statements, members, fields, arms) stay on their
//   own line, blank lines between entries are kept (several collapse into one), and trailing `//`
//   comments are aligned within runs of consecutive lines. A comment anywhere else (inside an
//   expression) makes the formatter copy that whole statement verbatim.
//
// Stage 0 builds documents as nested JS values and passes print callbacks around. Here documents are
// nodes in an arena (`nodes`, referenced by index: nothing is copied), and the lists of entries are a
// union (`Entry`) that one method prints. Widths are measured in UTF-16 units, as stage 0's JS
// strings are, so both stages break lines at the same places.
package fmt

import "std.json"
import "std.utf8"
import "app.lexer.{Span, Trivia}"
import "app.ast.*"
import "app.parser.{parse}"

pub type FmtOptions = { pub indent: int = 4, pub max_width: int = 100, pub trailing_commas: bool = true }

pub type FmtResult = { pub text: string?, pub code: string = "", pub message: string = "", pub span: Span = r{ start: 0, end: 0, line: 1, col: 1 } }

/// Formats a file. Files with syntax errors aren't formatted (`text: None`, and the first error).
pub fun format(source: &str, opts: &FmtOptions) -> FmtResult {
    let bytes = utf8.encode(source)
    let parsed = parse(bytes.clone())
    if let Some(d) = parsed.diagnostics.get(0) {
        return FmtResult { text: None, code: d.code, message: d.message, span: d.span }
    }
    var comments = parsed.lexed.trivia.clone()
    comments.sort_by(#{ a, b => if a.span.start < b.span.start { Less } else if a.span.start > b.span.start { Greater } else { Equal } })
    var f = Formatter { bytes, comments, o: opts.clone() }
    f.init()
    FmtResult { text: Some(f.file(parsed.file)) }
}

// ---- documents ------------------------------------------------------------------------------------

union Node = {
    NText(string)
    NCat(Vec[int])
    NGroup { d: int, brk: bool }
    NIndent(int)
    /// a space, or a newline when the group breaks
    NLine
    /// nothing, or a newline when the group breaks
    NSoft
    /// always a newline (breaks the enclosing groups)
    NHard
    NIfBreak { d: int, flat: int }
    /// never broken (header lines)
    NFlat(int)
    /// a trailing comment (and its column in the source): not measured
    NSuffix { s: string, col: int }
}

let LINE = 0
let SOFT = 1
let HARD = 2
let EMPTY = 3

/// Marks a trailing comment in the output, for the alignment pass.
let SUFFIX = "\u{1}"

/// The length of a string in UTF-16 units (what stage 0 measures).
fun u16len(s: &str) -> int {
    var n = 0
    var i = 0
    let len = s.len()
    for i < len {
        let b = s.byte_at(i)
        if b < 128 || b >= 192 {
            n += 1                      // the first byte of a character
        }
        if b >= 240 {
            n += 1                      // a character beyond the BMP: two UTF-16 units
        }
        i += 1
    }
    n
}

fun spaces(n: int) -> string {
    var s = ""
    var i = 0
    for i < n {
        s = "${s} "
        i += 1
    }
    s
}

/// Without trailing spaces.
fun trim_spaces_end(s: &str) -> string {
    var end = s.len()
    for end > 0 && s.byte_at(end - 1) == 32 {
        end -= 1
    }
    s.substring(0, end).to_str()
}

/// Without trailing whitespace (spaces, tabs, line breaks).
fun trim_ws_end(s: &str) -> string {
    var end = s.len()
    for end > 0 && is_ws(s.byte_at(end - 1)) {
        end -= 1
    }
    s.substring(0, end).to_str()
}

fun is_ws(b: u8) -> bool { b == 32 || b == 9 || b == 10 || b == 13 || b == 11 || b == 12 }

fun is_word(b: u8) -> bool { (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 95 }

fun last_index(s: &str, needle: &str) -> int {
    var found = -1
    var from = 0
    for let Some(k) = s.find(needle, from) {
        found = k
        from = k + 1
    }
    found
}

/// A record key: as written if it is an identifier, quoted otherwise.
fun key(k: &str) -> string {
    var ok = !k.is_empty()
    var i = 0
    for ok && i < k.len() {
        let b = k.byte_at(i)
        ok = is_word(b) && !(i == 0 && b >= 48 && b <= 57)
        i += 1
    }
    if ok { k.to_str() } else { json.stringify(k) }
}

/// Places trailing comments: in their source column if the code still ends before it (so aligned
/// comments stay aligned); otherwise the run of consecutive commented lines is aligned two spaces
/// after its longest line. Removes the markers.
fun align_comments(text: &str) -> string {
    var lines = text.split("\n").map(#{ l => l.to_str() })
    var i = 0
    for i < lines.len() {
        if !lines[i].contains(SUFFIX) {
            i += 1
            continue
        }
        var j = i
        for j < lines.len() && lines[j].contains(SUFFIX) {
            j += 1
        }
        var run = [] as Vec[t(string, int, string)]
        var k = i
        for k < j {
            let parts = lines[k].split(SUFFIX)
            let col = parts[1].to_int() ?? 0
            run.push(t(trim_spaces_end(parts[0]), col, parts[2].to_str()))
            k += 1
        }
        let keep = run.all(#{ r => r.1 >= u16len(r.0) + 2 })
        var widest = 0
        for r in run.iter() {
            let w = u16len(r.0)
            if w > widest {
                widest = w
            }
        }
        let aligned = widest + 2
        k = 0
        for r in run.iter() {
            let t(code, src_col, comment) = r
            let blank = code.trim().is_empty()
            let col = if blank { u16len(code) } else if keep { src_col } else { aligned }
            let min = if blank { 0 } else { 2 }
            let gap = col - u16len(code)
            lines[i + k] = "${code}${spaces(if gap > min { gap } else { min })}${comment}"
            k += 1
        }
        i = j
    }
    lines.join("\n")
}

type Cmd = r{ ind: string, brk: bool, d: int }

// ---- entries: what the lists of the formatter hold ----------------------------------------------

union Entry = {
    EHead(string)
    EImport(Import)
    EItem(Item)
    EVariant(Variant)
    EFun(FunDecl)
    EField(Field)
    EStmt { s: Stmt, last: bool }
    EArm(MatchArm)
    ESelArm(SelectArm)
    ESelElse(Expr)
    EElem(Elem)
    EMap(MapItem)
    ERec(RecordItem)
}

type Ent = { span: Span, e: Entry }

type Braced = { flat_sep: string = "; ", allow_flat: bool = true, empty: string = "{}", bare: bool = false }

// ---- the formatter --------------------------------------------------------------------------------

type Formatter = {
    bytes: Vec[u8]
    comments: Vec[Trivia]
    used: Set[int] = Set.new()
    o: FmtOptions
    line_starts: Vec[int] = [0]
    nodes: Vec[Node] = []
    hard: Vec[bool] = []
}

impl Formatter {
    fun init(&mut this) {
        var i = 0
        for i < this.bytes.len() {
            if this.bytes[i] == 10 {
                this.line_starts.push(i + 1)
            }
            i += 1
        }
        let _ = this.mk(NLine, false)
        let _ = this.mk(NSoft, false)
        let _ = this.mk(NHard, true)
        let _ = this.text("")
    }

    // ---- building documents ----

    fun mk(&mut this, n: Node, hard: bool) -> int {
        this.nodes.push(n)
        this.hard.push(hard)
        this.nodes.len() - 1
    }

    fun text(&mut this, s: &str) -> int {
        if s.is_empty() && this.nodes.len() > EMPTY {
            return EMPTY
        }
        this.mk(NText(s.to_str()), s.contains("\n"))
    }

    fun cat(&mut this, ds: Vec[int]) -> int {
        let h = ds.any(#{ d => this.hard[d] })
        this.mk(NCat(ds), h)
    }

    fun group(&mut this, d: int, brk: bool) -> int {
        let b = brk || this.hard[d]
        this.mk(NGroup { d, brk: b }, b)
    }

    fun indent(&mut this, d: int) -> int {
        let h = this.hard[d]
        this.mk(NIndent(d), h)
    }

    fun if_break(&mut this, d: int, flat: int) -> int {
        let h = this.hard[d]
        this.mk(NIfBreak { d, flat }, h)
    }

    fun flat(&mut this, d: int) -> int { this.mk(NFlat(d), false) }

    fun join(&mut this, sep: int, ds: &Vec[int]) -> Vec[int] {
        var out = [] as Vec[int]
        var i = 0
        for d in ds.iter() {
            if i > 0 {
                out.push(sep)
            }
            out.push(d)
            i += 1
        }
        out
    }

    fun join_str(&mut this, sep: &str, ds: &Vec[int]) -> int {
        let s = this.text(sep)
        let parts = this.join(s, ds)
        this.cat(parts)
    }

    fun is_suffix(&this, d: int) -> bool {
        match &this.nodes[d] {
            NSuffix { .. } => true
            _ => false
        }
    }

    /// A flat separator that becomes a newline when its group breaks: `"; "` → `;` + line.
    fun breakable_sep(&mut this, sep: &str) -> int {
        let visible = sep.trim()
        let e = this.text("")
        let f = this.text(if visible.is_empty() { " " } else { visible })
        let ib = this.if_break(e, f)
        this.cat([ib, LINE])
    }

    // ---- layout ----

    fun fits(&this, first: Cmd, width: int) -> bool {
        var w = width
        var work = [first] as Vec[Cmd]
        for w >= 0 && !work.is_empty() {
            let Some(c) = work.pop() else { break }
            match &this.nodes[c.d] {
                NText(s) => {
                    match s.find("\n", 0) {
                        Some(nl) => return w - u16len(s.substring(0, nl)) >= 0
                        None => w -= u16len(s)
                    }
                }
                NCat(ds) => {
                    var i = ds.len() - 1
                    for i >= 0 {
                        work.push(r{ ind: c.ind, brk: c.brk, d: ds[i] })
                        i -= 1
                    }
                }
                NGroup { d, brk } => work.push(r{ ind: c.ind, brk: brk, d: d })
                NIndent(d) => work.push(r{ ind: c.ind, brk: c.brk, d: d })
                NLine => {
                    if c.brk {
                        return true
                    }
                    w -= 1
                }
                NSoft => {
                    if c.brk {
                        return true
                    }
                }
                NHard => return true
                NIfBreak { d, flat } => work.push(r{ ind: c.ind, brk: c.brk, d: if c.brk { d } else { flat } })
                NFlat(d) => work.push(r{ ind: c.ind, brk: false, d: d })
                NSuffix { .. } => {}
            }
        }
        w >= 0
    }

    /// Lays a document out in `width` columns.
    fun render(&this, root: int, width: int, unit: &str) -> string {
        var out = [] as Vec[string]
        var col = 0
        var stack = [r{ ind: "", brk: true, d: root }] as Vec[Cmd]
        for let Some(c) = stack.pop() {
            match &this.nodes[c.d] {
                NText(s) => {
                    out.push(s.clone())
                    let nl = last_index(s, "\n")
                    col = if nl >= 0 { u16len(s.substring(nl + 1, s.len())) } else { col + u16len(s) }
                }
                NCat(ds) => {
                    var i = ds.len() - 1
                    for i >= 0 {
                        stack.push(r{ ind: c.ind, brk: c.brk, d: ds[i] })
                        i -= 1
                    }
                }
                NGroup { d, brk } => {
                    if !c.brk && !brk {
                        stack.push(r{ ind: c.ind, brk: false, d: d })
                    } else {
                        let flat_ok = !brk && this.fits(r{ ind: c.ind, brk: false, d: d }, width - col)
                        stack.push(r{ ind: c.ind, brk: !flat_ok, d: d })
                    }
                }
                NIndent(d) => stack.push(r{ ind: "${c.ind}${unit}", brk: c.brk, d: d })
                NLine => {
                    if !c.brk {
                        out.push(" ")
                        col += 1
                    } else {
                        col = newline(out, c.ind)
                    }
                }
                NSoft => {
                    if c.brk {
                        col = newline(out, c.ind)
                    }
                }
                NHard => col = newline(out, c.ind)
                NIfBreak { d, flat } => stack.push(r{ ind: c.ind, brk: c.brk, d: if c.brk { d } else { flat } })
                NFlat(d) => stack.push(r{ ind: c.ind, brk: false, d: d })
                NSuffix { s, col: at } => out.push("${SUFFIX}${at}${SUFFIX}${s}")
            }
        }
        out.join("")
    }

    // ---- source access ----

    fun src_text(&this, start: int, end: int) -> string { utf8.decode_range(this.bytes, start, end) }
    fun src(&this, span: Span) -> string { this.src_text(span.start, span.end) }

    fun line_of(&this, offset: int) -> int {
        var lo = 0
        var hi = this.line_starts.len() - 1
        for lo < hi {
            let mid = (lo + hi + 1) / 2
            if this.line_starts[mid] <= offset {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
        lo
    }

    /// Was the node written over several lines?
    fun multiline(&this, span: Span) -> bool {
        let last = if span.end - 1 > span.start { span.end - 1 } else { span.start }
        this.line_of(span.start) != this.line_of(last)
    }

    /// Is there a newline in the source between two offsets?
    fun broken_between(&this, a: int, b: int) -> bool { this.line_of(a) != this.line_of(b) }

    /// Does the source have a newline right after this offset (before the next token)?
    fun newline_after(&this, offset: int, end: int) -> bool {
        var i = offset
        for i < end {
            let c = this.bytes[i]
            if c == 10 {
                return true
            }
            if c != 32 && c != 9 && c != 13 {
                return false
            }
            i += 1
        }
        false
    }

    fun blank_between(&this, a: int, b: int) -> bool {
        // a newline, then only spaces / tabs / CRs, then another newline
        var i = a
        for i < b {
            if this.bytes[i] == 10 {
                var k = i + 1
                for k < b && (this.bytes[k] == 32 || this.bytes[k] == 9 || this.bytes[k] == 13) {
                    k += 1
                }
                if k < b && this.bytes[k] == 10 {
                    return true
                }
            }
            i += 1
        }
        false
    }

    // ---- comments ----

    fun comments_in(&this, start: int, end: int) -> Vec[int] {
        var out = [] as Vec[int]
        var i = 0
        for c in this.comments.iter() {
            if !this.used.has(i) && c.span.start >= start && c.span.end <= end {
                out.push(i)
            }
            i += 1
        }
        out
    }

    fun suffix(&mut this, i: int) -> int {
        let _ = this.used.insert(i)
        let start = this.comments[i].span.start
        let line_start = this.line_starts[this.line_of(start)]
        let col = u16len(this.src_text(line_start, start))
        let s = trim_ws_end(this.comments[i].text)
        this.mk(NSuffix { s, col }, false)
    }

    /// A comment right after an opening `{` (or a closure's `=>`), on the same line: it stays there.
    fun open_comment(&mut this, open: int, end: int) -> int? {
        let line = this.line_of(open)
        for i in this.comments_in(open, end).iter() {
            if this.line_of(this.comments[i].span.start) == line {
                if this.comments[i].kind == "doc" {
                    return None
                }
                return Some(this.suffix(i))
            }
        }
        None
    }

    /// Prints a list of entries one per line: their leading comments, blank lines between them,
    /// trailing comments, and comments before `end`.
    fun entries(&mut this, nodes: &Vec[Ent], start: int, end: int) -> Vec[int] {
        var out = [] as Vec[int]
        var prev_end = start
        var first = true
        for n in nodes.iter() {
            let t(pe, fi) = this.emit_comments(out, prev_end, n.span.start, first)
            prev_end = pe
            first = fi
            if !first {
                out.push(HARD)
                if this.blank_between(prev_end, n.span.start) {
                    out.push(HARD)
                }
            }
            let d = this.guarded(n)
            out.push(d)
            first = false
            prev_end = n.span.end
            // a trailing comment on the entry's last line
            let end_line = this.line_of(n.span.end - 1)
            var trailing: int? = None
            for i in this.comments_in(n.span.end, end).iter() {
                if this.line_of(this.comments[i].span.start) == end_line {
                    trailing = Some(i)
                    break
                }
            }
            if let Some(ti) = trailing {
                if this.comments[ti].kind != "doc" {
                    let s = this.suffix(ti)
                    out.push(s)
                    prev_end = this.comments[ti].span.end
                }
            }
        }
        let _ = this.emit_comments(out, prev_end, end, first)
        out
    }

    /// The comments not placed yet between `from` and `up_to`, each on its own line. Returns where the
    /// last one ends and whether nothing has been printed yet.
    fun emit_comments(&mut this, out: &mut Vec[int], from: int, up_to: int, first0: bool) -> t(int, bool) {
        var first = first0
        var prev_end = from
        for i in this.comments_in(from, up_to).iter() {
            let _ = this.used.insert(i)
            let start = this.comments[i].span.start
            if !first {
                out.push(HARD)
                if this.blank_between(prev_end, start) {
                    out.push(HARD)
                }
            }
            let d = this.text(trim_ws_end(this.comments[i].text))
            out.push(d)
            first = false
            prev_end = this.comments[i].span.end
        }
        t(prev_end, first)
    }

    /// Prints an entry; if it contains a comment the printer didn't place, copies it verbatim instead.
    fun guarded(&mut this, n: &Ent) -> int {
        let before = this.used.clone()
        let d = this.entry(n)
        let stray = this.comments_in(n.span.start, n.span.end)
        if stray.is_empty() {
            return d
        }
        // undo what the attempt claimed inside, then take the source as it is
        for i in this.used.clone().iter() {
            if !before.has(i) {
                let _ = this.used.remove(i)
            }
        }
        for i in this.comments_in(n.span.start, n.span.end).iter() {
            let _ = this.used.insert(i)
        }
        let s = this.src(n.span)
        this.text(s)
    }

    fun entry(&mut this, n: &Ent) -> int {
        match &n.e {
            EHead(s) => this.text(s)
            EImport(i) => this.import_decl(i)
            EItem(itm) => this.item(itm)
            EVariant(v) => {
                let s = this.variant(v)
                this.text(s)
            }
            EFun(f) => this.fun(f)
            EField(x) => this.field(x)
            EStmt { s, last } => this.stmt(s, last)
            EArm(a) => this.arm(a)
            ESelArm(a) => {
                var parts = [] as Vec[int]
                if let Some(p) = &a.pattern {
                    let ps = this.pattern(p)
                    parts.push(this.text("${ps} = "))
                }
                parts.push(this.expr(a.expr))
                parts.push(this.text(" => "))
                parts.push(this.expr(a.body))
                this.cat(parts)
            }
            ESelElse(e) => {
                let h = this.text("else => ")
                let b = this.expr(e)
                this.cat([h, b])
            }
            EElem(x) => this.elem(x)
            EMap(x) => match x {
                MSpread { expr, .. } => {
                    let dots = this.text("...")
                    let v = this.expr(expr)
                    this.cat([dots, v])
                }
                MEntry(me) => {
                    let k = this.expr(me.key)
                    let colon = this.text(": ")
                    let v = this.expr(me.value)
                    this.cat([k, colon, v])
                }
            }
            ERec(x) => match x {
                RSpread { expr, .. } => {
                    let dots = this.text("...")
                    let v = this.expr(expr)
                    this.cat([dots, v])
                }
                RField(rf) => match &rf.value {
                    None => this.text(key(rf.key))
                    Some(v) => {
                        let k = this.text("${key(rf.key)}: ")
                        let vd = this.expr(v)
                        this.cat([k, vd])
                    }
                }
            }
        }
    }

    /// Statements / members between braces: `{ … }` flat if allowed and it fits, else one per line.
    fun braced(&mut this, nodes: &Vec[Ent], span: Span, opts: Braced) -> int {
        let first_start = match nodes.get(0) {
            Some(n) => n.span.start
            None => span.end - 1
        }
        let head = this.open_comment(span.start + 1, first_start)
        let inner = this.entries(nodes, span.start + 1, span.end - 1)
        if inner.is_empty() && head.is_none() {
            return this.text(opts.empty)
        }
        let can_flat = head.is_none() && opts.allow_flat && !this.multiline(span) && !nodes.is_empty() && !inner.any(#{ d => this.is_suffix(d) })
        if can_flat {
            let entries = inner.filter(#{ d => d != HARD })
            if nodes.len() == entries.len() {
                let sep = this.breakable_sep(opts.flat_sep)
                let flat_docs = this.join(sep, entries)
                let open = this.text("{")
                let close = this.text("}")
                var body = [LINE] as Vec[int]
                body.extend(flat_docs)
                let b = this.cat(body)
                let ind = this.indent(b)
                let all = this.cat([open, ind, LINE, close])
                // bare: the caller groups it (the blocks of an `if` chain break together)
                return if opts.bare { all } else { this.group(all, false) }
            }
        }
        this.expanded("{", head, inner)
    }

    /// `open`, an optional comment after it, the entries one per line, `}`.
    fun expanded(&mut this, open: &str, head: int?, inner: Vec[int]) -> int {
        let o = this.text(open)
        let h = head ?? EMPTY
        var body = [HARD] as Vec[int]
        body.extend(inner)
        let b = this.cat(body)
        let ind = this.indent(b)
        let close = this.text("}")
        this.cat([o, h, ind, HARD, close])
    }

    // ---- file and items ----

    fun file(&mut this, f: &File) -> string {
        var all = [] as Vec[Ent]
        if !f.package_path.is_empty() {
            all.push(Ent { span: this.find_package_span(), e: EHead("package ${f.package_path.join(".")}") })
        }
        for imp in f.imports.iter() {
            all.push(Ent { span: imp.span, e: EImport(imp.clone()) })
        }
        for itm in f.items.iter() {
            all.push(Ent { span: item_span(itm), e: EItem(itm.clone()) })
        }
        let parts = this.entries(all, 0, this.bytes.len())
        let body = this.cat(parts)
        let doc = this.cat([body, HARD])
        let text = align_comments(this.render(doc, this.o.max_width, spaces(this.o.indent)))
        var end = text.len()
        for end > 0 && text.byte_at(end - 1) == 10 {
            end -= 1
        }
        "${text.substring(0, end)}\n"
    }

    /// The span of `package x.y` (after leading whitespace and comments).
    fun find_package_span(&this) -> Span {
        let n = this.bytes.len()
        var i = 0
        for i < n {
            let c = this.bytes[i]
            if is_ws(c) {
                i += 1
            } else if c == 47 && i + 1 < n && this.bytes[i + 1] == 47 {
                // `//…\n` (a line comment must end with its newline)
                var k = i + 2
                for k < n && this.bytes[k] != 10 {
                    k += 1
                }
                if k >= n {
                    break
                }
                i = k + 1
            } else if c == 47 && i + 1 < n && this.bytes[i + 1] == 42 {
                var k = i + 2
                var closed = false
                for k + 1 < n {
                    if this.bytes[k] == 42 && this.bytes[k + 1] == 47 {
                        closed = true
                        break
                    }
                    k += 1
                }
                if !closed {
                    break
                }
                i = k + 2
            } else {
                break
            }
        }
        // `package`, whitespace, then a dotted name
        let word = "package"
        var ok = i + word.len() <= n
        var k = 0
        for ok && k < word.len() {
            ok = this.bytes[i + k] == word.byte_at(k)
            k += 1
        }
        if ok {
            var j = i + word.len()
            var gap = 0
            for j < n && is_ws(this.bytes[j]) {
                j += 1
                gap += 1
            }
            var name = 0
            for j < n && (is_word(this.bytes[j]) || this.bytes[j] == 46) {
                j += 1
                name += 1
            }
            if gap > 0 && name > 0 {
                return r{ start: i, end: j, line: this.line_of(i) + 1, col: 1 }
            }
        }
        r{ start: 0, end: 0, line: this.line_of(0) + 1, col: 1 }
    }

    fun import_decl(&mut this, i: &Import) -> int {
        let p = if i.is_pub { "pub " } else { "" }
        let alias = match &i.alias {
            Some(a) => " as ${a}"
            None => ""
        }
        this.text("import ${p}${json.stringify(i.path)}${alias}")
    }

    fun impls_text(&this, ts: &Vec[Type]) -> string {
        if ts.is_empty() { "" } else { ": ${ts.map(#{ x => this.type_text(x) }).join(", ")}" }
    }

    fun item(&mut this, itm: &Item) -> int {
        match itm {
            Fun(f) => this.fun(f)
            TypeDef(d) => {
                let p = if d.is_pub { "pub " } else { "" }
                let h = this.text("${p}type ${d.name}${this.generics(d.generics)}${this.impls_text(d.impls)} = ")
                let head = this.flat(h)
                let body = match &d.body {
                    Struct(b) => this.struct_body(b)
                    Alias(t) => {
                        let s = this.type_text(t)
                        this.text(s)
                    }
                }
                this.cat([head, body])
            }
            Union(d) => {
                let p = if d.is_pub { "pub " } else { "" }
                let h = this.text("${p}union ${d.name}${this.generics(d.generics)}${this.impls_text(d.impls)} = ")
                let head = this.flat(h)
                var members = [] as Vec[Ent]
                for v in d.variants.iter() {
                    members.push(Ent { span: v.span, e: EVariant(v.clone()) })
                }
                for m in d.methods.iter() {
                    members.push(Ent { span: m.span, e: EFun(m.clone()) })
                }
                sort_ents(members)
                let span = this.body_span(d.span)
                let body = this.braced(members, span, Braced { flat_sep: "  ", allow_flat: d.methods.is_empty() })
                this.cat([head, body])
            }
            Inter(d) => {
                let p = if d.is_pub { "pub " } else { "" }
                let supers = if d.supers.is_empty() { "" } else { ": ${d.supers.map(#{ x => this.type_text(x) }).join(", ")}" }
                let head = "${p}inter ${d.name}${this.generics(d.generics)}${supers} = "
                if let Some(c) = &d.composition {
                    let ht = this.text(head)
                    let ct = this.text(this.type_text(c))
                    let both = this.cat([ht, ct])
                    return this.flat(both)
                }
                let ht = this.text(head)
                let hf = this.flat(ht)
                let methods = (d.methods ?? []).map(#{ m => Ent { span: m.span, e: EFun(m.clone()) } })
                let span = this.body_span(d.span)
                let body = this.braced(methods, span, Braced {})
                this.cat([hf, body])
            }
            Impl(d) => {
                let ifaces = if d.interfaces.is_empty() { "" } else { "${d.interfaces.map(#{ x => this.type_text(x) }).join(", ")} for " }
                let ht = this.text("impl${this.generics(d.generics)} ${ifaces}${this.type_text(d.target)} ")
                let hf = this.flat(ht)
                let methods = d.methods.map(#{ m => Ent { span: m.span, e: EFun(m.clone()) } })
                let span = this.body_span(d.span)
                let body = this.braced(methods, span, Braced { allow_flat: false })
                this.cat([hf, body])
            }
            Let(d) => {
                let p = if d.is_pub { "pub " } else { "" }
                let ty = match &d.ty {
                    Some(t) => ": ${this.type_text(t)}"
                    None => ""
                }
                let h = this.text("${p}let ${d.name}${ty} = ")
                let v = this.expr(d.value)
                this.cat([h, v])
            }
            Extern(d) => {
                let h = this.text("extern ${json.stringify(d.abi)} ")
                let funs = d.funs.map(#{ m => Ent { span: m.span, e: EFun(m.clone()) } })
                let span = this.body_span(d.span)
                let body = this.braced(funs, span, Braced { allow_flat: false })
                this.cat([h, body])
            }
        }
    }

    /// The `{ … }` at the end of an item: from the `{` that matches its final `}`.
    fun body_span(&this, span: Span) -> Span {
        var depth = 0
        var open = [] as Vec[int]
        var i = span.start
        let end = span.end
        for i < end {
            let c = this.bytes[i]
            if c == 34 {
                // a string: skip it (and its escapes)
                i += 1
                for i < end && this.bytes[i] != 34 {
                    if this.bytes[i] == 92 {
                        i += 1
                    }
                    i += 1
                }
                i += 1
                continue
            }
            if c == 47 && i + 1 < end && this.bytes[i + 1] == 47 {
                for i < end && this.bytes[i] != 10 {
                    i += 1
                }
                continue
            }
            if c == 123 {
                open.push(i)
                depth += 1
            } else if c == 125 {
                depth -= 1
                let o = open.pop() ?? span.start
                if depth == 0 && i == end - 1 {
                    return r{ start: o, end: span.end, line: this.line_of(o) + 1, col: 1 }
                }
            }
            i += 1
        }
        span
    }

    fun generics(&this, gs: &Vec[GenericParam]) -> string {
        if gs.is_empty() {
            return ""
        }
        let parts = gs.map(#{ g =>
            if g.bounds.is_empty() { g.name.clone() } else { "${g.name}: ${g.bounds.map(#{ b => this.type_text(b) }).join(" & ")}" }
        })
        "[${parts.join(", ")}]"
    }

    fun fun(&mut this, f: &FunDecl) -> int {
        var params = [] as Vec[string]
        if let Some(r) = &f.receiver {
            params.push(r.clone())
        }
        for p in f.params.iter() {
            let m = if p.is_mut { "mut " } else { "" }
            let v = if p.variadic { "..." } else { "" }
            params.push("${m}${v}${p.name}: ${this.type_text(p.ty)}")
        }
        let pb = if f.is_pub { "pub " } else { "" }
        let ab = if f.is_async { "async " } else { "" }
        let ret = match &f.ret {
            Some(t) => " -> ${this.type_text(t)}"
            None => ""
        }
        let s = this.text("${pb}${ab}fun ${f.name}${this.generics(f.generics)}(${params.join(", ")})${ret}")
        let sig = this.flat(s)
        let Some(b) = &f.body else { return sig }
        let sp = this.text(" ")
        let body = this.block(b, true)
        this.cat([sig, sp, body])
    }

    fun struct_body(&mut this, b: &StructBody) -> int {
        var members = [] as Vec[Ent]
        for x in b.fields.iter() {
            members.push(Ent { span: x.span, e: EField(x.clone()) })
        }
        for m in b.methods.iter() {
            members.push(Ent { span: m.span, e: EFun(m.clone()) })
        }
        sort_ents(members)
        this.braced(members, b.span, Braced { flat_sep: ", ", allow_flat: b.methods.is_empty() })
    }

    fun field(&mut this, x: &Field) -> int {
        let p = if x.is_pub { "pub " } else { "" }
        let h = this.text("${p}${x.name}: ${this.type_text(x.ty)}")
        let Some(d) = &x.default else { return h }
        let eq = this.text(" = ")
        let v = this.expr(d)
        this.cat([h, eq, v])
    }

    fun variant(&this, v: &Variant) -> string {
        if let Some(ts) = &v.tuple {
            return "${v.name}(${ts.map(#{ x => this.type_text(x) }).join(", ")})"
        }
        if let Some(fs) = &v.fields {
            let parts = fs.map(#{ f => "${if f.is_pub { "pub " } else { "" }}${f.name}: ${this.type_text(f.ty)}" })
            return "${v.name} { ${parts.join(", ")} }"
        }
        v.name.clone()
    }

    // ---- types ----

    fun type_text(&this, t: &Type) -> string {
        match &t.kind {
            TName { path, args } => {
                let a = if args.is_empty() { "" } else { "[${args.map(#{ x => this.type_text(x) }).join(", ")}]" }
                "${path.join(".")}${a}"
            }
            TOption(inner) => "${this.type_text(inner.get())}?"
            TRef { is_mut, inner } => "&${if is_mut { "mut " } else { "" }}${this.type_text(inner.get())}"
            TPtr { is_mut, inner } => "*${if is_mut { "mut " } else { "" }}${this.type_text(inner.get())}"
            TTuple(ts) => "t(${ts.map(#{ x => this.type_text(x) }).join(", ")})"
            TRecord(fs) => "r{ ${fs.map(#{ f => "${f.name}: ${this.type_text(f.ty)}" }).join(", ")} }"
            TFn { params, ret } => "(${params.map(#{ x => this.type_text(x) }).join(", ")}) -> ${this.type_text(ret.get())}"
            TTypeOf(path) => "TypeOf(${path.join(".")})"
            TLiteral(_) | TError => this.src(t.span)
            TUnion(ts) => ts.map(#{ x => this.type_text(x) }).join(" | ")
            TIntersection(ts) => ts.map(#{ x => this.type_text(x) }).join(" & ")
        }
    }

    // ---- statements ----

    fun stmt_ents(&this, stmts: &Vec[Stmt]) -> Vec[Ent] {
        var out = [] as Vec[Ent]
        let n = stmts.len()
        var i = 0
        for s in stmts.iter() {
            out.push(Ent { span: stmt_span(s), e: EStmt { s: s.clone(), last: i == n - 1 } })
            i += 1
        }
        out
    }

    fun block(&mut this, b: &Block, allow_flat: bool) -> int {
        let ents = this.stmt_ents(b.stmts)
        this.braced(ents, b.span, Braced { flat_sep: "; ", allow_flat })
    }

    fun bare_block(&mut this, b: &Block) -> int {
        let ents = this.stmt_ents(b.stmts)
        this.braced(ents, b.span, Braced { flat_sep: "; ", bare: true })
    }

    fun stmt(&mut this, s: &Stmt, last: bool) -> int {
        match s {
            ExprStmt(es) => {
                let e = this.expr(es.expr)
                let semi = this.text(if es.semi && last { ";" } else { "" })
                this.cat([e, semi])
            }
            Let(l) => {
                let value = this.expr(l.value)
                let pat = this.pattern(l.pattern)
                if l.short {
                    let h = this.text("${pat}${if l.mutable { " :== " } else { " := " }}")
                    return this.cat([h, value])
                }
                let ty = match &l.ty {
                    Some(t) => ": ${this.type_text(t)}"
                    None => ""
                }
                let h = this.text("${if l.mutable { "var" } else { "let" }} ${pat}${ty} = ")
                var parts = [h, value] as Vec[int]
                if let Some(eb) = &l.else_branch {
                    parts.push(this.text(" else "))
                    parts.push(this.block(eb, true))
                }
                this.cat(parts)
            }
        }
    }

    // ---- expressions ----

    fun expr(&mut this, e: &Expr) -> int {
        match &e.kind {
            Ident(name) => this.text(name)
            This => this.text("this")
            Int(_) | Float(_) | Str { .. } | Template(_) | Char(_) | Error => {
                let s = this.src(e.span)
                this.text(s)
            }
            Bool(b) => this.text(if b { "true" } else { "false" })
            Nil => this.text("nil")
            Paren(x) => {
                let o = this.text("(")
                let v = this.expr(x.get())
                let c = this.text(")")
                this.cat([o, v, c])
            }
            VecLit(elems) => this.seq("[", elems, "]", e.span)
            ArrayLit(elems) => this.seq("a[", elems, "]", e.span)
            TupleLit(elems) => this.seq("t(", elems, ")", e.span)
            SetLit(elems) => {
                let items = elems.map(#{ x => Ent { span: elem_span(x), e: EElem(x.clone()) } })
                this.braced_seq("s{", items, e.span)
            }
            MapLit(entries) => {
                let items = entries.map(#{ x => Ent { span: map_span(x), e: EMap(x.clone()) } })
                this.braced_seq("m{", items, e.span)
            }
            RecordLit(fields) => {
                let items = record_ents(fields)
                this.braced_seq("r{", items, e.span)
            }
            Inferred(fields) => {
                let items = record_ents(fields)
                this.braced_seq("_{", items, e.span)
            }
            StructLit { ty, fields } => {
                let t = this.expr(ty.get())
                let sp = this.text(" ")
                let items = record_ents(fields)
                let body = this.braced_seq("{", items, r{ start: ty.get().span.end, end: e.span.end, line: e.span.line, col: e.span.col })
                this.cat([t, sp, body])
            }
            Closure { .. } => this.closure(e)
            Unary { op, expr } => {
                let o = this.text(if op == "&mut" { "&mut " } else { op })
                let v = this.expr(expr.get())
                this.cat([o, v])
            }
            Await(x) => {
                let a = this.text("await ")
                let v = this.expr(x.get())
                this.cat([a, v])
            }
            Binary { op, left, right } => {
                let broken = this.broken_between(left.get().span.end, right.get().span.start)
                let l = this.expr(left.get())
                let o = this.text(" ${op}")
                let sep = if broken { this.indent(HARD) } else { this.text(" ") }
                let r = this.expr(right.get())
                this.cat([l, o, sep, r])
            }
            Assign { op, target, value } => {
                let t = this.expr(target.get())
                let o = this.text(" ${op} ")
                let v = this.expr(value.get())
                this.cat([t, o, v])
            }
            RangeExpr { op, start, end } => {
                let s = match start {
                    Some(x) => this.expr(x.get())
                    None => EMPTY
                }
                let o = this.text(op)
                let en = match end {
                    Some(x) => this.expr(x.get())
                    None => EMPTY
                }
                this.cat([s, o, en])
            }
            As { expr, ty } => {
                let v = this.expr(expr.get())
                let a = this.text(" as ${this.type_text(ty)}")
                this.cat([v, a])
            }
            Or { expr, name, rhs, .. } => {
                let broken = this.broken_between(expr.get().span.end, rhs.get().span.start) && !this.newline_after_or(expr.get(), rhs.get())
                let n = match name {
                    Some(x) => "${x} => "
                    None => ""
                }
                let nd = this.text(n)
                let rd = this.expr(rhs.get())
                let rhs_doc = this.cat([nd, rd])
                let v = this.expr(expr.get())
                if broken {
                    let o = this.text("or ")
                    let inner = this.cat([HARD, o, rhs_doc])
                    let ind = this.indent(inner)
                    return this.cat([v, ind])
                }
                let o = this.text(" or ")
                this.cat([v, o, rhs_doc])
            }
            Member { object, name, .. } | OptMember { object, name, .. } => {
                let dot = match &e.kind {
                    Member { .. } => "."
                    _ => "?."
                }
                let obj = this.expr(object.get())
                if this.chain_broken(object.get().span.end, e.span.end) {
                    let d = this.text("${dot}${name}")
                    let inner = this.cat([HARD, d])
                    let ind = this.indent(inner)
                    return this.cat([obj, ind])
                }
                let d = this.text("${dot}${name}")
                this.cat([obj, d])
            }
            // `t (1)` calls `t` and `a [0]` indexes `a`: glued, they would be the sigils `t(` / `a[` (spec §1.6)
            Call { callee, args } => {
                let c = this.expr(callee.get())
                let gap = this.text(if is_ident(callee.get(), "t") { " " } else { "" })
                let a = this.args(args, e.span)
                this.cat([c, gap, a])
            }
            IndexExpr { object, index } => {
                let o = this.expr(object.get())
                let open = this.text(if is_ident(object.get(), "a") { " [" } else { "[" })
                let i = this.expr(index.get())
                let close = this.text("]")
                this.cat([o, open, i, close])
            }
            GenericApply { target, args } => {
                let t = this.expr(target.get())
                let a = this.text(".[${args.map(#{ x => this.type_text(x) }).join(", ")}]")
                this.cat([t, a])
            }
            Try(x) => {
                let v = this.expr(x.get())
                let q = this.text("?")
                this.cat([v, q])
            }
            If { .. } => {
                let parts = this.if_parts(e)
                let c = this.cat(parts)
                this.group(c, false)
            }
            Match { .. } => this.match_expr(e)
            Select { .. } => this.select_expr(e)
            For { .. } => this.for_expr(e)
            BlockExpr(b) => this.block(b, true)
            Unsafe(b) => {
                let k = this.text("unsafe ")
                let body = this.block(b, true)
                this.cat([k, body])
            }
            Recover(b) => {
                let k = this.text("recover ")
                let body = this.block(b, true)
                this.cat([k, body])
            }
            Return(v) => match v {
                Some(x) => {
                    let k = this.text("return ")
                    let d = this.expr(x.get())
                    this.cat([k, d])
                }
                None => this.text("return")
            }
            Break { label, value } => {
                let l = match label {
                    Some(x) => " ${x}"
                    None => ""
                }
                let k = this.text("break${l}")
                match value {
                    Some(x) => {
                        let sp = this.text(" ")
                        let d = this.expr(x.get())
                        this.cat([k, sp, d])
                    }
                    None => k
                }
            }
            Continue(label) => match label {
                Some(x) => this.text("continue ${x}")
                None => this.text("continue")
            }
        }
    }

    /// `x or\n  y` (newline after `or`) is rare; keep `or` where the author put it only when it starts the line.
    fun newline_after_or(&this, x: &Expr, rhs: &Expr) -> bool {
        // stage 0: `!/\n\s*or\b/.test(between)`, `between` running from `x` to `rhs`
        let b = rhs.span.start
        var i = x.span.end
        for i < b {
            if this.bytes[i] == 10 {
                var k = i + 1
                for k < b && is_ws(this.bytes[k]) {
                    k += 1
                }
                if k + 2 <= b && this.bytes[k] == 111 && this.bytes[k + 1] == 114 && (k + 2 == b || !is_word(this.bytes[k + 2])) {
                    return false
                }
            }
            i += 1
        }
        true
    }

    /// `a\n    .b()`: the author broke the chain before this `.`.
    fun chain_broken(&this, from: int, to: int) -> bool {
        var i = from
        var saw_newline = false
        for i < to && is_ws(this.bytes[i]) {
            if this.bytes[i] == 10 {
                saw_newline = true
            }
            i += 1
        }
        if !saw_newline || i >= to {
            return false
        }
        if this.bytes[i] == 63 {
            i += 1
        }
        i < to && this.bytes[i] == 46
    }

    fun elem(&mut this, x: &Elem) -> int {
        match x {
            EValue(v) => this.expr(v)
            ESpread { expr, .. } => {
                let d = this.text("...")
                let v = this.expr(expr)
                this.cat([d, v])
            }
        }
    }

    /// `(a, b)`, `[a, b]`: a group that breaks with one element per line (and a trailing comma).
    fun seq(&mut this, open: &str, elems: &Vec[Elem], close: &str, span: Span) -> int {
        if elems.is_empty() {
            return this.text("${open}${close}")
        }
        let expanded = this.newline_after(span.start + open.len(), span.end) && elems.len() > 1
        var items = [] as Vec[int]
        for x in elems.iter() {
            items.push(this.elem(x))
        }
        let comma = this.text(",")
        let sep = this.cat([comma, LINE])
        let joined = this.join(sep, items)
        var inner = [SOFT] as Vec[int]
        inner.extend(joined)
        let ic = this.cat(inner)
        let ind = this.indent(ic)
        let o = this.text(open)
        let trailing = if this.o.trailing_commas {
            let c = this.text(",")
            this.if_break(c, EMPTY)
        } else {
            EMPTY
        }
        let c = this.text(close)
        let all = this.cat([o, ind, trailing, SOFT, c])
        this.group(all, expanded)
    }

    fun args(&mut this, args: &Vec[Elem], span: Span) -> int {
        let open = this.find_open_paren(span, args)
        // `xs.map(#{ x =>` … `})`: a multi-line closure or literal as the last argument stays hugged
        if let Some(last) = args.last() {
            let ls = elem_span(last)
            if huggable(last) && this.multiline(ls) && !this.newline_after(open + 1, ls.start) {
                let n = args.len()
                var simple = true
                var i = 0
                for i < n - 1 {
                    if this.multiline(elem_span(args[i])) {
                        simple = false
                    }
                    i += 1
                }
                if simple {
                    var docs = [] as Vec[int]
                    for a in args.iter() {
                        docs.push(this.elem(a))
                    }
                    let o = this.text("(")
                    let j = this.join_str(", ", docs)
                    let c = this.text(")")
                    return this.cat([o, j, c])
                }
            }
        }
        this.seq("(", args, ")", r{ start: open, end: span.end, line: span.line, col: span.col })
    }

    /// The offset of a call's `(`: just before its first argument, or before the final `)`.
    fun find_open_paren(&this, span: Span, args: &Vec[Elem]) -> int {
        let limit = match args.get(0) {
            Some(a) => elem_span(a).start
            None => span.end
        }
        let text = this.src_text(span.start, limit)
        let i = last_index(text, "(")
        span.start + (if i < 0 { 0 } else { i })
    }

    /// `m{ k: v }`, `r{ a }`, `User { … }`: flat with commas if it fits (and was flat), else one per line.
    fun braced_seq(&mut this, open: &str, items: Vec[Ent], span: Span) -> int {
        if items.is_empty() {
            return this.text("${open}}")
        }
        let first = items[0].span.start
        let brace_at = this.find_brace(span, first)
        let body = r{ start: brace_at, end: span.end, line: span.line, col: span.col }
        let head = this.open_comment(brace_at + 1, first)
        let inner = this.entries(items, brace_at + 1, span.end - 1)
        if head.is_none() && !this.multiline(body) && !inner.any(#{ d => this.is_suffix(d) }) {
            let flat_docs = inner.filter(#{ d => d != HARD })
            if flat_docs.len() == items.len() {
                let comma = this.text(",")
                let sep = this.cat([comma, LINE])
                let joined = this.join(sep, flat_docs)
                let j = this.cat(joined)
                let ic = this.cat([LINE, j])
                let ind = this.indent(ic)
                let o = this.text(open)
                let c = this.text("}")
                let all = this.cat([o, ind, LINE, c])
                return this.group(all, false)
            }
        }
        this.expanded(open, head, inner)
    }

    fun find_brace(&this, span: Span, first_item: int) -> int {
        let text = this.src_text(span.start, first_item)
        let i = last_index(text, "{")
        span.start + (if i < 0 { 0 } else { i })
    }

    fun closure(&mut this, e: &Expr) -> int {
        let Closure { captures, params, ret, body } = &e.kind else { return EMPTY }
        let caps = match captures {
            Some(cs) => "[${cs.map(#{ c => "${if c.mode == "ref" { "&" } else if c.mode == "mut" { "&mut " } else { "" }}${c.name}" }).join(", ")}]"
            None => ""
        }
        let header = match params {
            None => ""
            Some(ps) => {
                let list = ps.map(#{ p =>
                    let ty = match &p.ty {
                        Some(t) => ": ${this.type_text(t)}"
                        None => ""
                    }
                    "${if p.is_mut { "mut " } else { "" }}${p.name}${ty}"
                })
                let r = match ret {
                    Some(t) => " -> ${this.type_text(t)}"
                    None => ""
                }
                "${list.join(", ")}${r} =>"
            }
        }
        let open = "#${caps}{"
        let ents = this.stmt_ents(body.stmts)
        let body_start = this.closure_body_start(e)
        let first = match body.stmts.get(0) {
            Some(s) => stmt_span(s).start
            None => e.span.end - 1
        }
        let head = this.open_comment(body_start, first)
        let inner = this.entries(ents, body_start, e.span.end - 1)
        if inner.is_empty() && head.is_none() {
            return this.text("${open} ${header}${if header.is_empty() { "" } else { " " }}}")
        }
        let flat_docs = inner.filter(#{ d => d != HARD })
        if head.is_none() && !this.multiline(e.span) && !inner.any(#{ d => this.is_suffix(d) }) && flat_docs.len() == body.stmts.len() {
            let start = this.text("${open} ${header}${if header.is_empty() { "" } else { " " }}")
            let j = this.join_str("; ", flat_docs)
            let end = this.text(" }")
            let all = this.cat([start, j, end])
            return this.group(all, false)
        }
        // a header-less closure starts its body on the next line
        let start = this.text("${open}${if header.is_empty() { "" } else { " ${header}" }}")
        let h = head ?? EMPTY
        var lines = [HARD] as Vec[int]
        lines.extend(inner)
        let b = this.cat(lines)
        let ind = this.indent(b)
        let close = this.text("}")
        this.cat([start, h, ind, HARD, close])
    }

    /// Where a closure's statements may start: after `=>` (or the `{`).
    fun closure_body_start(&this, e: &Expr) -> int {
        let Closure { params, body, .. } = &e.kind else { return e.span.start }
        let limit = match body.stmts.get(0) {
            Some(s) => stmt_span(s).start
            None => e.span.end
        }
        let text = this.src_text(e.span.start, limit)
        let arrow = if params.is_some() { text.find("=>", 0) } else { None }
        let at = match arrow {
            Some(k) => k + 2
            None => (text.find("{", 0) ?? -1) + 1
        }
        e.span.start + at
    }

    fun if_parts(&mut this, e: &Expr) -> Vec[int] {
        let If { cond, then, else_branch } = &e.kind else { return [] }
        let c = match cond {
            CLet(lc) => {
                let p = this.pattern(lc.pattern)
                let h = this.text("let ${p} = ")
                let v = this.expr(lc.value.get())
                this.cat([h, v])
            }
            CExpr(x) => this.expr(x.get())
        }
        let k = this.text("if ")
        let cf = this.flat(c)
        let sp = this.text(" ")
        let tb = this.bare_block(then)
        var out = [k, cf, sp, tb] as Vec[int]
        if let Some(eb) = else_branch {
            out.push(this.text(" else "))
            match &eb.get().kind {
                If { .. } => out.extend(this.if_parts(eb.get()))
                BlockExpr(b) => out.push(this.bare_block(b))
                _ => out.push(this.expr(eb.get()))
            }
        }
        out
    }

    fun arm(&mut this, a: &MatchArm) -> int {
        let head = match &a.pattern {
            Some(p) => {
                let s = this.pattern(p)
                this.text(s)
            }
            None => match &a.test {
                Some(t) => this.expr(t)
                None => this.text("_")
            }
        }
        var parts = [head] as Vec[int]
        if let Some(g) = &a.guard {
            parts.push(this.text(" if "))
            parts.push(this.expr(g))
        }
        parts.push(this.text(" => "))
        parts.push(this.expr(a.body))
        this.cat(parts)
    }

    fun match_expr(&mut this, e: &Expr) -> int {
        let Match { subject, arms } = &e.kind else { return EMPTY }
        var head = [] as Vec[int]
        match subject {
            Some(s) => {
                head.push(this.text("match "))
                let sd = this.expr(s.get())
                head.push(this.flat(sd))
                head.push(this.text(" "))
            }
            None => head.push(this.text("match "))
        }
        let ents = arms.map(#{ a => Ent { span: a.span, e: EArm(a.clone()) } })
        let span = this.body_span(e.span)
        head.push(this.braced(ents, span, Braced { flat_sep: ", " }))
        this.cat(head)
    }

    fun select_expr(&mut this, e: &Expr) -> int {
        let Select { arms, else_branch } = &e.kind else { return EMPTY }
        var ents = arms.map(#{ a => Ent { span: a.span, e: ESelArm(a.clone()) } })
        if let Some(els) = else_branch {
            let from = match arms.last() {
                Some(a) => a.span.end
                None => e.span.start
            }
            let x = els.get()
            let text = this.src_text(from, x.span.start)
            let i = last_index(text, "else")
            let start = if i >= 0 { from + i } else { x.span.start }
            ents.push(Ent { span: r{ start, end: x.span.end, line: x.span.line, col: x.span.col }, e: ESelElse(x.clone()) })
        }
        let k = this.text("select ")
        let span = this.body_span(e.span)
        let body = this.braced(ents, span, Braced { allow_flat: false })
        this.cat([k, body])
    }

    fun for_expr(&mut this, e: &Expr) -> int {
        let For { label, form, is_await, pattern, pattern2, expr, body } = &e.kind else { return EMPTY }
        let lbl = match label {
            Some(l) => "${l}: "
            None => ""
        }
        let header = if form == "infinite" {
            EMPTY
        } else if form == "cond" {
            let Some(x) = expr else { return EMPTY }
            let c = this.expr(x.get())
            let sp = this.text(" ")
            this.cat([c, sp])
        } else if form == "let" {
            let Some(x) = expr else { return EMPTY }
            let Some(p) = pattern else { return EMPTY }
            let ps = this.pattern(p)
            let h = this.text("let ${ps} = ")
            let v = this.expr(x.get())
            let sp = this.text(" ")
            this.cat([h, v, sp])
        } else {
            let Some(x) = expr else { return EMPTY }
            let Some(p) = pattern else { return EMPTY }
            let p2 = match pattern2 {
                Some(q) => ", ${this.pattern(q)}"
                None => ""
            }
            let h = this.text("${if is_await { "await " } else { "" }}${this.pattern(p)}${p2} in ")
            let v = this.expr(x.get())
            let sp = this.text(" ")
            this.cat([h, v, sp])
        }
        let l = this.text("${lbl}for ")
        let hf = this.flat(header)
        let b = this.block(body, false)
        this.cat([l, hf, b])
    }

    // ---- patterns ----

    fun pattern(&this, p: &Pattern) -> string {
        match &p.kind {
            PWild => "_"
            PBind { name, is_mut } => "${if is_mut { "mut " } else { "" }}${name}"
            PLit(_) | PError => this.src(p.span)
            PRange { op, start, end } => {
                let s = match start {
                    Some(x) => this.src(x.get().span)
                    None => ""
                }
                let e = match end {
                    Some(x) => this.src(x.get().span)
                    None => ""
                }
                "${s}${op}${e}"
            }
            PPath(path) => path.join(".")
            PCall { path, args, rest } => {
                var parts = args.map(#{ a => this.pattern(a) })
                if rest {
                    parts.push("..")
                }
                "${path.join(".")}(${parts.join(", ")})"
            }
            PStruct { path, fields, rest } => {
                var parts = fields.map(#{ f => match &f.pattern {
                    Some(fp) => "${f.name}: ${this.pattern(fp)}"
                    None => f.name.clone()
                } })
                if rest {
                    parts.push("..")
                }
                let head = match path {
                    Some(ps) => "${ps.join(".")} "
                    None => "r"
                }
                "${head}{ ${parts.join(", ")} }"
            }
            PTuple { elems, rest } => {
                var parts = elems.map(#{ a => this.pattern(a) })
                if rest {
                    parts.push("..")
                }
                "t(${parts.join(", ")})"
            }
            POr(alts) => alts.map(#{ a => this.pattern(a) }).join(" | ")
        }
    }
}

fun sort_ents(xs: &mut Vec[Ent]) {
    xs.sort_by(#{ a, b => if a.span.start < b.span.start { Less } else if a.span.start > b.span.start { Greater } else { Equal } })
}

fun record_ents(fields: &Vec[RecordItem]) -> Vec[Ent] {
    fields.map(#{ f => Ent { span: record_span(f), e: ERec(f.clone()) } })
}

fun is_ident(e: &Expr, name: &str) -> bool {
    match &e.kind {
        Ident(n) => n == name
        _ => false
    }
}

fun huggable(x: &Elem) -> bool {
    match x {
        EValue(e) => match &e.kind {
            Closure { .. } | StructLit { .. } | RecordLit(_) | Inferred(_) | MapLit(_) | SetLit(_) => true
            _ => false
        }
        ESpread { .. } => false
    }
}

/// Moves `nl` into `out`: trailing spaces of the line before are removed. Returns the new column.
fun newline(out: &mut Vec[string], ind: &str) -> int {
    let n = out.len()
    if n > 0 && out[n - 1].ends_with(" ") {
        out[n - 1] = trim_spaces_end(out[n - 1])
    }
    out.push("\n${ind}")
    ind.len()
}

fun elem_span(x: &Elem) -> Span {
    match x {
        EValue(e) => e.span
        ESpread { span, .. } => span
    }
}

fun map_span(x: &MapItem) -> Span {
    match x {
        MEntry(me) => me.span
        MSpread { span, .. } => span
    }
}

fun record_span(x: &RecordItem) -> Span {
    match x {
        RField(rf) => rf.span
        RSpread { span, .. } => span
    }
}

fun stmt_span(s: &Stmt) -> Span {
    match s {
        Let(l) => l.span
        ExprStmt(es) => es.span
    }
}

fun item_span(itm: &Item) -> Span {
    match itm {
        Fun(d) => d.span
        TypeDef(d) => d.span
        Union(d) => d.span
        Inter(d) => d.span
        Impl(d) => d.span
        Let(d) => d.span
        Extern(d) => d.span
    }
}
