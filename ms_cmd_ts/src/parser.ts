import { lex, type Token, type Span, type LexResult } from "./lexer.ts";
import type { Program, Node, TypeNode, Expr, Stmt, Diagnostic } from "./parser/ast.ts";

const EMPTY: Span = { start: 0, end: 0, line: 1, column: 1, endLine: 1, endColumn: 1 };
const K = (kind: string) => kind;
const INFIX: Record<string, [number, number]> = {
  "OP_=": [1, 1], "OP_:=": [1, 1], "OP_:==": [1, 1], "OP_+=": [1, 1], "OP_-=": [1, 1], "OP_*=": [1, 1], "OP_/=": [1, 1], "OP_%=": [1, 1],
  "OP_||": [3, 4], "OP_&&": [4, 5], "OP_|": [5, 6], "OP_^": [6, 7], "OP_&": [7, 8],
  "OP_==": [8, 9], "OP_!=": [8, 9], "OP_<": [9, 10], "OP_<=": [9, 10], "OP_>": [9, 10], "OP_>=": [9, 10], "KW_AS": [9, 10],
  "OP_..": [10, 11], "OP_..=": [10, 11], "KW_OR": [11, 12],
  "OP_<<": [12, 13], "OP_>>": [12, 13], "OP_+": [13, 14], "OP_-": [13, 14],
  "OP_*": [14, 15], "OP_/": [14, 15], "OP_%": [14, 15],
};
const BIN = new Set(["OP_||", "OP_&&", "OP_|", "OP_^", "OP_&", "OP_==", "OP_!=", "OP_<", "OP_<=", "OP_>", "OP_>=", "OP_..", "OP_..=", "OP_<<", "OP_>>", "OP_+", "OP_-", "OP_*", "OP_/", "OP_%"]);

export class MinScriptParser {
  readonly tokens: Token[];
  readonly diagnostics: Diagnostic[] = [];
  readonly source: string;
  private i = 0;
  constructor(input: string | LexResult) {
    const result = typeof input === "string" ? lex(input) : input;
    this.source = result.source; this.tokens = result.tokens;
    for (const e of result.errors) this.diagnostics.push({ code: e.code, message: e.message, span: e.span });
  }
  parse(): Program {
    const start = this.peek()?.span ?? EMPTY, items: Node[] = [];
    while (!this.atEnd()) {
      const before = this.i;
      try { items.push(this.parseTopLevel()); }
      catch (e) { this.report("E_PARSE", e instanceof Error ? e.message : String(e), this.peek()?.span ?? EMPTY); this.synchronize(); }
      if (this.i === before) this.advance();
    }
    return { kind: "Program", items, span: this.join(start, this.previous()?.span ?? start) };
  }
  private parseTopLevel(): Node {
    const start = this.peek()!.span;
    if (this.match("DOC_COMMENT")) return { kind: "DocComment", text: this.previous()!.value, span: this.previous()!.span };
    const isPub = this.match("KW_PUB");
    if (this.match("KW_PACKAGE")) { const name = this.expect("IDENT", "Expected package name"); this.endStatement(); return { kind: "PackageDecl", name: name.lexeme, public: !!isPub, span: this.join(start, name.span) }; }
    if (this.match("KW_IMPORT")) { const path = this.expect("STRING_START", "Expected quoted import path"); const value = this.parseStringAfterStart(path); const alias = this.match("KW_AS") ? this.expect("IDENT", "Expected import alias").lexeme : undefined; this.endStatement(); return { kind: "ImportDecl", path: value, alias, public: !!isPub, span: this.join(start, this.previous()!.span) }; }
    if (this.match("KW_ASYNC")) { this.expect("KW_FUN", "Expected fun after async"); return this.parseFunction(start, !!isPub, true); }
    if (this.match("KW_FUN")) return this.parseFunction(start, !!isPub, false);
    if (this.match("KW_TYPE")) return this.parseTypeDecl(start, !!isPub);
    if (this.match("KW_INTER")) return this.parseInterDecl(start, !!isPub);
    if (this.match("KW_IMPL")) return this.parseImpl(start);
    if (this.match("KW_EXTERN")) return this.parseExtern(start, !!isPub);
    if (isPub || this.at("KW_LET")) return this.parseStatement();
    throw new Error(`Unexpected ${this.peek()?.lexeme ?? "end of input"} at top level`);
  }
  private parseFunction(start: Span, isPub: boolean, async: boolean): Node {
    const name = this.expect("IDENT", "Expected function name").lexeme;
    const generics = this.parseGenericParams(); this.expect("LPAREN", "Expected ( after function name");
    const params: Node[] = [];
    while (!this.at("RPAREN") && !this.atEnd()) {
      const pStart = this.peek()!.span, variadic = this.match("OP_..."), mutable = this.match("KW_MUT");
      let receiver: string | undefined;
      if (this.match("KW_THIS")) receiver = mutable ? "mut this" : "this";
      else if (this.match("OP_&")) { const mut = this.match("KW_MUT"); this.expect("KW_THIS", "Expected this receiver"); receiver = mut ? "&mut this" : "&this"; }
      else { const pname = this.expect("IDENT", "Expected parameter name").lexeme; this.expect("OP_:", "Expected : after parameter name"); const type = this.parseType(); params.push({ kind: "Parameter", name: pname, type, mutable, variadic, span: this.join(pStart, type.span) }); continue; }
      params.push({ kind: "Receiver", receiver, span: this.join(pStart, this.previous()!.span) });
      if (this.at("RPAREN")) break;
      this.expect("OP_,", "Expected comma between parameters");
    }
    this.expect("RPAREN", "Expected ) after parameters");
    const result = this.match("OP_->") ? this.parseType() : undefined;
    const body = this.at("LBRACE") ? this.parseBlock() : undefined;
    return { kind: "FunctionDecl", name, generics, params, result, body, public: isPub, async, span: this.join(start, body?.span ?? this.previous()!.span) };
  }
  private parseTypeDecl(start: Span, isPub: boolean): Node {
    const name = this.expect("IDENT", "Expected type name").lexeme, generics = this.parseGenericParams();
    this.expect("OP_=", "Expected = in type declaration");
    let value: any;
    if (this.match("OP_|")) {
      const variants: Node[] = [];
      do { const vstart = this.peek()!.span; const vname = this.expect("IDENT", "Expected variant name").lexeme; let payload: any;
        if (this.match("LPAREN")) { const args = this.parseTypeList("RPAREN"); this.expect("RPAREN", "Expected )"); payload = args; }
        else if (this.match("LBRACE")) payload = this.parseTypeFields("RBRACE");
        variants.push({ kind: "VariantDecl", name: vname, payload, span: this.join(vstart, this.previous()!.span) });
      } while (this.match("OP_|"));
      value = { kind: "SumType", variants, span: this.join(start, this.previous()!.span) };
    } else if (this.match("LBRACE")) value = { kind: "StructType", fields: this.parseTypeFields("RBRACE"), span: this.join(start, this.previous()!.span) };
    else { value = this.parseType(); if (this.match("OP_|")) { const members: TypeNode[] = [value]; do { members.push(this.parseType()); } while (this.match("OP_|")); const literal = members.every((m: any) => m.form === "Literal" || (m.form === "Path" && ["true", "false"].includes(m.name))); value = { kind: "Type", form: literal ? "LiteralUnion" : "Union", members, span: this.join(start, members[members.length - 1].span) }; if (!literal) this.report("E_UNION_TYPE", "Unions of existing types are not supported; declare a sum type with a leading |", value.span); } }
    this.endStatement(); return { kind: "TypeDecl", name, generics, value, public: isPub, span: this.join(start, this.previous()!.span) };
  }
  private parseInterDecl(start: Span, isPub: boolean): Node {
    const name = this.expect("IDENT", "Expected interface name").lexeme, generics = this.parseGenericParams();
    const supers = this.match("OP_:") ? this.parseTypeListUntil("=") : [];
    this.expect("OP_=", "Expected = before interface body"); this.expect("LBRACE", "Expected interface body");
    const members: Node[] = []; while (!this.at("RBRACE") && !this.atEnd()) { if (this.match("KW_PUB")) {} if (this.match("KW_FUN")) members.push(this.parseFunction(this.previous()!.span, false, false)); else { this.report("E_INTER_MEMBER", "Expected fun in interface body", this.peek()!.span); this.synchronizeBlock(); } }
    const close = this.expect("RBRACE", "Expected } after interface body"); return { kind: "InterfaceDecl", name, generics, supers, members, public: isPub, span: this.join(start, close.span) };
  }
  private parseImpl(start: Span): Node {
    const generics = this.parseGenericParams(); const first = this.parseType(); let interfaces: TypeNode[] = [], target = first;
    if (this.match("KW_FOR")) { interfaces = [first]; target = this.parseType(); while (this.match("OP_,")) interfaces.push(this.parseType()); }
    this.expect("LBRACE", "Expected impl body"); const members: Node[] = [];
    while (!this.at("RBRACE") && !this.atEnd()) { const pub = this.match("KW_PUB"); if (this.match("KW_FUN")) members.push(this.parseFunction(this.previous()!.span, !!pub, false)); else { this.report("E_IMPL_MEMBER", "Expected fun in impl body", this.peek()!.span); this.synchronizeBlock(); } }
    const close = this.expect("RBRACE", "Expected } after impl body"); return { kind: "ImplDecl", generics, target, interfaces, members, span: this.join(start, close.span) };
  }
  private parseExtern(start: Span, isPub: boolean): Node {
    const abi = this.match("STRING_START") ? this.parseStringAfterStart(this.previous()!) : undefined;
    this.expect("LBRACE", "Expected extern block"); const members: Node[] = [];
    while (!this.at("RBRACE") && !this.atEnd()) { const pub = this.match("KW_PUB"); if (this.match("KW_FUN")) members.push(this.parseFunction(this.previous()!.span, !!pub, false)); else this.synchronizeBlock(); }
    const close = this.expect("RBRACE", "Expected } after extern block"); return { kind: "ExternDecl", abi, members, public: isPub, span: this.join(start, close.span) };
  }
  private parseGenericParams(): Node[] {
    if (!this.match("LBRACKET")) return []; const params: Node[] = [];
    while (!this.at("RBRACKET") && !this.atEnd()) { const s = this.peek()!.span; const isConst = false; const name = this.expect("IDENT", "Expected generic parameter").lexeme; const bounds = this.match("OP_:") ? this.parseTypeList() : []; params.push({ kind: "GenericParam", name, const: isConst, bounds, span: this.join(s, this.previous()!.span) }); if (!this.match("OP_,")) break; }
    this.expect("RBRACKET", "Expected ] after generic parameters"); return params;
  }
  private parseStatement(): Stmt {
    const start = this.peek()!.span;
    if (this.match("DOC_COMMENT")) return { kind: "DocComment", text: this.previous()!.value, span: this.previous()!.span };
    if (this.match("KW_LET") || this.match("KW_VAR")) { const mutable = this.previous()!.kind === "KW_VAR"; const pattern = this.parsePattern(); const type = this.match("OP_:") ? this.parseType() : undefined; this.expect("OP_=", "Expected = in declaration"); const value = this.parseExpression(); const otherwise = this.match("KW_ELSE") ? this.parseBlock() : undefined; this.endStatement(); return { kind: "VariableDecl", mutable, pattern, type, value, otherwise, span: this.join(start, this.previous()!.span) }; }
    if (this.match("KW_RETURN")) { const value = this.canStartExpression() && !this.peek()!.nl_before ? this.parseExpression() : undefined; this.endStatement(); return { kind: "ReturnStmt", value, span: this.join(start, this.previous()!.span) }; }
    if (this.match("KW_BREAK") || this.match("KW_CONTINUE")) { const kind = this.previous()!.kind === "KW_BREAK" ? "BreakStmt" : "ContinueStmt"; const value = kind === "BreakStmt" && this.canStartExpression() && !this.peek()!.nl_before ? this.parseExpression() : undefined; this.endStatement(); return { kind, value, span: this.join(start, this.previous()!.span) }; }
    if (this.match("KW_IF")) return this.parseIf(start);
    if (this.match("KW_WHILE")) { const condition = this.match("KW_LET") ? { kind: "LetCondition", pattern: this.parsePattern(), value: (this.expect("OP_=", "Expected = in while let"), this.parseExpression()) } : this.parseExpression(); const body = this.parseBlock(); return { kind: "WhileStmt", condition, body, span: this.join(start, body.span) }; }
    if (this.match("KW_FOR")) { let pattern: any = this.parsePattern(); if (this.match("OP_,")) { const parts = [pattern, this.parsePattern()]; pattern = { kind: "TuplePattern", parts, span: this.join(parts[0].span, parts[1].span) }; } this.expect("KW_IN", "Expected in after loop pattern"); const iterable = this.parseExpression(); const body = this.parseBlock(); return { kind: "ForStmt", pattern, iterable, body, span: this.join(start, body.span) }; }
    if (this.match("KW_LOOP")) { const body = this.parseBlock(); return { kind: "LoopStmt", body, span: this.join(start, body.span) }; }
    if (this.match("KW_MATCH")) return this.parseMatch(start);
    if (this.match("KW_UNSAFE") || this.match("KW_RECOVER")) { const kind = this.previous()!.kind === "KW_UNSAFE" ? "UnsafeExpr" : "RecoverExpr"; const body = this.parseBlock(); return { kind, body, span: this.join(start, body.span) }; }
    const expression = this.parseExpression(); const semi = this.match("OP_;"); if (!semi) this.endStatement();
    if (expression.kind === "AssignExpr" && (expression.operator === ":=" || expression.operator === ":==")) {
      if (expression.left.kind !== "NameExpr") this.report("E_SHORT_DECL_LHS", ":= and :== require a plain identifier on the left", expression.left.span);
      return { kind: "VariableDecl", mutable: expression.operator === ":==", pattern: { kind: "BindingPattern", name: expression.left.name, span: expression.left.span }, value: expression.right, shorthand: true, span: this.join(start, this.previous()?.span ?? expression.span) };
    }
    return { kind: "ExprStmt", expression, terminated: !!semi, span: this.join(start, this.previous()?.span ?? expression.span) };
  }
  private parseIf(start: Span): Stmt {
    const condition = this.match("KW_LET") ? { kind: "LetCondition", pattern: this.parsePattern(), value: (this.expect("OP_=", "Expected = in if let"), this.parseExpression()) } : this.parseExpression(); const then = this.parseBlock(); let otherwise: any;
    if (this.match("KW_ELSE")) otherwise = this.match("KW_IF") ? this.parseIf(this.previous()!.span) : this.parseBlock();
    return { kind: "IfExpr", condition, then, otherwise, span: this.join(start, otherwise?.span ?? then.span) };
  }
  private parseMatch(start: Span): Stmt {
    const value = this.parseExpression(); this.expect("LBRACE", "Expected match body"); const arms: Node[] = [];
    while (!this.at("RBRACE") && !this.atEnd()) { const s = this.peek()!.span; const pattern = this.parsePattern(); const guard = this.match("KW_IF") ? this.parseExpression() : undefined; this.expect("OP_=>", "Expected => in match arm"); const body = this.at("LBRACE") ? this.parseBlock() : this.parseExpression(); arms.push({ kind: "MatchArm", pattern, guard, body, span: this.join(s, body.span) }); this.match("OP_,"); this.skipNewlines(); }
    const close = this.expect("RBRACE", "Expected } after match"); return { kind: "MatchExpr", value, arms, span: this.join(start, close.span) };
  }
  private parseBlock(): Expr {
    const open = this.expect("LBRACE", "Expected block"); const statements: Node[] = []; let tail: Expr | undefined;
    while (!this.at("RBRACE") && !this.atEnd()) { const before = this.i; const stmt = this.parseStatement(); if (stmt.kind === "ExprStmt" && !stmt.terminated && this.at("RBRACE")) tail = stmt.expression; else statements.push(stmt); if (this.i === before) this.advance(); }
    const close = this.expect("RBRACE", "Expected } after block"); return { kind: "BlockExpr", statements, tail, span: this.join(open.span, close.span) };
  }
  private parseExpression(min = 0): Expr {
    let left = this.parsePrefix(); left = this.parsePostfix(left);
    while (!this.atEnd()) {
      const key = this.peek()!.kind;
      const bp = INFIX[key]; if (!bp || bp[0] < min) break;
      const op = this.advance();
      if (op.kind === "KW_AS") { const type = this.parseType(); left = { kind: "CastExpr", expression: left, type, span: this.join(left.span, type.span) }; continue; }
      if (op.kind === "KW_OR") { let binding: string | undefined; if (this.at("IDENT") && this.peek(1)?.kind === "OP_=>") { binding = this.advance().lexeme; this.advance(); } const right = this.at("LBRACE") ? this.parseBlock() : this.parseExpression(bp[1]); left = { kind: "OrExpr", expression: left, binding, fallback: right, span: this.join(left.span, right.span) }; continue; }
      const right = this.parseExpression(bp[1]); left = { kind: bp[0] === 1 ? "AssignExpr" : "BinaryExpr", operator: op.lexeme, left, right, span: this.join(left.span, right.span) };
    }
    return left;
  }
  private parsePrefix(): Expr {
    const t = this.peek()!;
    if (t.kind === "KW_AWAIT") { this.advance(); const operand = this.parsePostfix(this.parsePrefix(), false); return { kind: "AwaitExpr", operator: t.lexeme, operand, span: this.join(t.span, operand.span) }; }
    if (["OP_!", "OP_-", "OP_+", "OP_*", "OP_&"].includes(t.kind)) { this.advance(); const operand = this.parseExpression(15); return { kind: "UnaryExpr", operator: t.lexeme, operand, span: this.join(t.span, operand.span) }; }
    if (this.match("KW_IF")) return this.parseIf(t.span) as Expr;
    if (this.match("KW_MATCH")) return this.parseMatch(t.span) as Expr;
    if (this.match("KW_UNSAFE") || this.match("KW_RECOVER")) { const kind = this.previous()!.kind === "KW_UNSAFE" ? "UnsafeExpr" : "RecoverExpr"; const body = this.parseBlock(); return { kind, body, span: this.join(t.span, body.span) }; }
    if (this.match("KW_RETURN")) { const value = this.canStartExpression() ? this.parseExpression() : undefined; return { kind: "ReturnExpr", value, span: this.join(t.span, value?.span ?? t.span) }; }
    if (this.match("KW_BREAK") || this.match("KW_CONTINUE")) return { kind: this.previous()!.kind === "KW_BREAK" ? "BreakExpr" : "ContinueExpr", span: t.span };
    if (this.match("KW_TRUE") || this.match("KW_FALSE") || this.match("KW_NIL")) return { kind: "LiteralExpr", value: t.kind === "KW_TRUE" ? true : t.kind === "KW_FALSE" ? false : null, span: t.span };
    if (this.match("INT") || this.match("FLOAT") || this.match("CHAR") || this.match("RAW_STRING")) return { kind: "LiteralExpr", value: t.value ?? t.lexeme, span: t.span };
    if (this.match("STRING_START")) return { kind: "StringExpr", parts: this.parseStringParts(), span: this.join(t.span, this.previous()!.span) };
    if (this.match("IDENT") || this.match("IT_IDENT") || this.match("KW_THIS") || this.match("KW_SELF")) return { kind: "NameExpr", name: t.lexeme, span: t.span };
    if (this.match("LPAREN")) {
      const open = this.previous()!; const closeIndex = open.matching;
      if (closeIndex !== null && ["OP_=>", "OP_->"].includes(this.tokens[closeIndex + 1]?.kind ?? "")) return this.parseClosureFromParams(open);
      const expression = this.parseExpression(); const close = this.expect("RPAREN", "Expected )"); return { kind: "GroupExpr", expression, span: this.join(open.span, close.span) };
    }
    if (this.match("TUPLE_OPEN")) return this.parseDelimitedLiteral("TupleExpr", "RPAREN", t.span);
    if (this.match("ARRAY_OPEN")) return this.parseDelimitedLiteral("ArrayExpr", "RBRACKET", t.span);
    if (this.match("VEC_OPEN")) return this.parseDelimitedLiteral("VectorExpr", "RBRACKET", t.span);
    if (this.match("RECORD_OPEN")) return this.parseRecord("RecordExpr", t.span, "RBRACE");
    if (this.match("MAP_OPEN")) return this.parseMap(t.span);
    if (this.match("SET_OPEN")) return this.parseDelimitedLiteral("SetExpr", "RBRACE", t.span);
    if (this.match("INFERRED_OPEN")) return this.parseRecord("InferredRecordExpr", t.span, "RBRACE");
    if (this.match("TAGGED_RECORD_OPEN")) return this.parseRecord("TaggedRecordExpr", t.span, "RBRACE", t.value as string);
    if (this.match("CLOSURE_OPEN")) return this.parseImplicitClosure(t.span);
    if (this.match("CAPTURE_OPEN")) return this.parseCaptureClosure(t.span);
    if (this.match("LBRACE")) { this.i--; return this.parseBlock(); }
    throw new Error(`Expected expression, found ${t.lexeme || "end of input"}`);
  }
  private parsePostfix(base: Expr, allowPropagation = true): Expr {
    for (;;) {
      if (this.match("OP_.") || this.match("OP_?.")) { const optional = this.previous()!.kind === "OP_?."; const name = this.advance(); base = { kind: optional ? "OptionalMemberExpr" : "MemberExpr", object: base, property: name.lexeme, span: this.join(base.span, name.span) }; continue; }
      if (this.at("LBRACKET") && this.peek()!.matching !== null && this.tokens[this.peek()!.matching! + 1]?.kind === "LPAREN") {
        const open = this.advance(), typeArgs = this.parseGenericArgs(), close = this.expect("RBRACKET", "Expected ] after generic arguments");
        base = { kind: "GenericExpr", expression: base, typeArgs, span: this.join(base.span, close.span) }; continue;
      }
      if (this.match("LBRACKET")) { const index = this.parseExpression(); const close = this.expect("RBRACKET", "Expected ] after index"); base = { kind: "IndexExpr", object: base, index, span: this.join(base.span, close.span) }; continue; }
      if (this.match("LPAREN")) { const args = this.parseArguments("RPAREN"); const close = this.expect("RPAREN", "Expected ) after arguments"); base = { kind: "CallExpr", callee: base, args, span: this.join(base.span, close.span) }; continue; }
      if (allowPropagation && this.match("OP_?")) { base = { kind: "PropagateExpr", expression: base, span: this.join(base.span, this.previous()!.span) }; continue; }
      if (this.match("OP_++") || this.match("OP_--")) { base = { kind: "PostfixExpr", operator: this.previous()!.lexeme, expression: base, span: this.join(base.span, this.previous()!.span) }; continue; }
      break;
    }
    return base;
  }
  private parseClosureFromParams(open: Token): Expr {
    const params: Node[] = [];
    while (!this.at("RPAREN") && !this.atEnd()) { const s = this.peek()!.span; const name = this.expect("IDENT", "Expected closure parameter").lexeme; const type = this.match("OP_:") ? this.parseType() : undefined; params.push({ kind: "Parameter", name, type, span: this.join(s, this.previous()!.span) }); if (!this.match("OP_,")) break; }
    this.expect("RPAREN", "Expected ) after closure parameters"); const result = this.match("OP_->") ? this.parseType() : undefined; this.expect("OP_=>", "Expected => after closure parameters"); const body = this.at("LBRACE") ? this.parseBlock() : this.parseExpression(); return { kind: "ClosureExpr", params, result, body, captures: [], span: this.join(open.span, body.span) };
  }
  private parseImplicitClosure(start: Span): Expr {
    const params: string[] = []; let body: any;
    if (this.at("IDENT") && this.peek(1)?.kind === "OP_," || this.at("IDENT") && this.peek(1)?.kind === "OP_=>") { do { params.push(this.expect("IDENT", "Expected closure parameter").lexeme); } while (this.match("OP_,")); this.expect("OP_=>", "Expected => after closure parameters"); body = this.at("LBRACE") ? this.parseBlock() : this.parseExpression(); }
    else body = this.at("LBRACE") ? this.parseBlock() : this.parseExpression();
    const close = this.expect("RBRACE", "Expected } after closure");
    return { kind: "ImplicitClosureExpr", params: params.length ? params : ["it"], body, span: this.join(start, close.span) };
  }
  private parseCaptureClosure(start: Span): Expr {
    const captures: string[] = []; while (!this.at("RBRACKET") && !this.atEnd()) { captures.push(this.expect("IDENT", "Expected capture name").lexeme); if (!this.match("OP_,")) break; } this.expect("RBRACKET", "Expected ] after captures");
    if (this.match("LPAREN")) { const params: Node[] = []; while (!this.at("RPAREN") && !this.atEnd()) { const s = this.peek()!.span, name = this.expect("IDENT", "Expected parameter").lexeme; params.push({ kind: "Parameter", name, span: s }); if (!this.match("OP_,")) break; } this.expect("RPAREN", "Expected )"); this.expect("OP_=>", "Expected =>"); const body = this.at("LBRACE") ? this.parseBlock() : this.parseExpression(); return { kind: "ClosureExpr", captures, params, body, span: this.join(start, body.span) }; }
    const body = this.parseBlock(); return { kind: "ClosureExpr", captures, params: [], body, span: this.join(start, body.span) };
  }
  private parseDelimitedLiteral(kind: string, closeKind: string, start: Span): Expr { const elements = this.parseArguments(closeKind, true); const close = this.expect(closeKind, `Expected ${closeKind}`); return { kind, elements, span: this.join(start, close.span) }; }
  private parseArguments(closeKind: string, allowSpread = false): Expr[] { const args: Expr[] = []; while (!this.at(closeKind) && !this.atEnd()) { if (allowSpread && this.match("OP_...")) { const value = this.parseExpression(); args.push({ kind: "SpreadExpr", value, span: this.join(this.previous()!.span, value.span) }); } else args.push(this.parseExpression()); if (!this.match("OP_,")) { if (!this.at(closeKind) && !this.peek()!.nl_before) break; } this.skipNewlines(); } return args; }
  private parseRecord(kind: string, start: Span, closeKind: string, tag?: string): Expr { const fields: Node[] = []; while (!this.at(closeKind) && !this.atEnd()) { const s = this.peek()!.span; if (this.match("OP_...")) { const value = this.parseExpression(); fields.push({ kind: "SpreadField", value, span: this.join(s, value.span) }); } else { const name = this.match("IDENT") ? this.previous()!.lexeme : this.match("STRING_START") ? this.parseStringAfterStart(this.previous()!) : ""; if (!name) throw new Error("Expected record field name"); let value: any; if (this.match("OP_:")) value = this.parseExpression(); else value = { kind: "NameExpr", name, span: s }; fields.push({ kind: "RecordField", name, value, span: this.join(s, value.span) }); } if (!this.match("OP_,")) { if (!this.at(closeKind) && !this.peek()!.nl_before) break; } this.skipNewlines(); } const close = this.expect(closeKind, `Expected ${closeKind}`); return { kind, fields, tag, span: this.join(start, close.span) }; }
  private parseMap(start: Span): Expr { const entries: Node[] = []; while (!this.at("RBRACE") && !this.atEnd()) { const s = this.peek()!.span, key = this.parseExpression(); this.expect("OP_:", "Expected : after map key"); const value = this.parseExpression(); entries.push({ kind: "MapEntry", key, value, span: this.join(s, value.span) }); if (!this.match("OP_,")) { if (!this.at("RBRACE") && !this.peek()!.nl_before) break; } this.skipNewlines(); } const close = this.expect("RBRACE", "Expected } after map"); return { kind: "MapExpr", entries, span: this.join(start, close.span) }; }
  parseType(): TypeNode {
    const start = this.peek()!.span; let type: TypeNode;
    if (this.match("OP_&") || this.match("OP_*")) { const ptr = this.previous()!.lexeme; const mutable = this.match("KW_MUT"); const inner = this.parseType(); type = { kind: "Type", form: ptr === "&" ? "Reference" : "Pointer", inner, mutable, span: this.join(start, inner.span) }; }
    else if (this.match("TUPLE_OPEN")) { const members = this.parseTypeList("RPAREN"); const close = this.expect("RPAREN", "Expected )"); type = { kind: "Type", form: "Tuple", members, span: this.join(start, close.span) }; }
    else if (this.match("RECORD_OPEN")) { const fields = this.parseTypeFields("RBRACE"); type = { kind: "Type", form: "Record", fields, span: this.join(start, this.previous()!.span) }; }
    else if (this.match("LPAREN")) { const params = this.parseTypeList("RPAREN"); this.expect("RPAREN", "Expected )"); if (this.match("OP_->")) { const result = this.parseType(); type = { kind: "Type", form: "Function", params, result, span: this.join(start, result.span) }; } else if (params.length === 1) type = { ...params[0], span: this.join(start, this.previous()!.span) }; else throw new Error("Use t(...) for tuple types; parenthesized types are grouping or function types"); }
    else if (this.match("STRING_START")) { const value = this.parseStringAfterStart(this.previous()!); type = { kind: "Type", form: "Literal", name: value, span: this.join(start, this.previous()!.span) }; }
    else if (this.match("KW_TYPEOF")) { this.expect("LPAREN", "Expected ( after TypeOf"); const path = this.parsePath(); const close = this.expect("RPAREN", "Expected ) after TypeOf path"); type = { kind: "Type", form: "TypeOf", name: path, span: this.join(start, close.span) }; }
    else { const name = this.parsePath(); const args: Array<TypeNode | number> = []; if (this.match("LBRACKET")) { while (!this.at("RBRACKET") && !this.atEnd()) { if (this.at("INT")) args.push(Number(this.advance().value)); else args.push(this.parseType()); if (!this.match("OP_,")) break; } const close = this.expect("RBRACKET", "Expected ] after type arguments"); type = { kind: "Type", form: "Path", name, args, span: this.join(start, close.span) }; } else type = { kind: "Type", form: "Path", name, args, span: this.join(start, this.previous()!.span) }; }
    while (this.match("OP_?")) type = { kind: "Type", form: "Optional", inner: type, span: this.join(start, this.previous()!.span) };
    while (this.match("OP_&")) { const right = this.parseType(); type = { kind: "Type", form: "Intersection", members: [type, right], span: this.join(start, right.span) }; }
    return type;
  }
  private parseGenericArgs(): Array<TypeNode | number> { const args: Array<TypeNode | number> = []; while (!this.at("RBRACKET") && !this.atEnd()) { args.push(this.at("INT") ? Number(this.advance().value) : this.parseType()); if (!this.match("OP_,")) break; } return args; }
  private parseTypeList(close = "RBRACKET"): TypeNode[] { const list: TypeNode[] = []; while (!this.at(close) && !this.atEnd()) { list.push(this.parseType()); if (!this.match("OP_,")) break; } return list; }
  private parseTypeListUntil(endLexeme: string): TypeNode[] { const list: TypeNode[] = []; while (!this.at("EOF") && this.peek()!.lexeme !== endLexeme) { list.push(this.parseType()); if (!this.match("OP_,")) break; } return list; }
  private parseTypeFields(closeKind: string): Node[] { const fields: Node[] = []; while (!this.at(closeKind) && !this.atEnd()) { const s = this.peek()!.span, pub = this.match("KW_PUB"), name = this.expect("IDENT", "Expected field name").lexeme; this.expect("OP_:", "Expected : after field name"); const type = this.parseType(); fields.push({ kind: "TypeField", name, type, public: !!pub, span: this.join(s, type.span) }); if (!this.match("OP_,")) { if (!this.at(closeKind) && !this.peek()!.nl_before) break; } this.skipNewlines(); } const close = this.expect(closeKind, `Expected ${closeKind}`); return fields; }
  private parsePattern(): Node {
    const start = this.peek()!.span; let pattern: any;
    if (this.match("WILDCARD")) pattern = { kind: "WildcardPattern", span: start };
    else if (this.match("INT") || this.match("FLOAT") || this.match("CHAR") || this.match("KW_TRUE") || this.match("KW_FALSE") || this.match("KW_NIL")) pattern = { kind: "LiteralPattern", value: this.previous()!.value ?? this.previous()!.lexeme, span: start };
    else if (this.match("TUPLE_OPEN")) { const parts: Node[] = []; while (!this.at("RPAREN") && !this.atEnd()) { parts.push(this.parsePattern()); if (!this.match("OP_,")) break; } const close = this.expect("RPAREN", "Expected )"); pattern = { kind: "TuplePattern", parts, span: this.join(start, close.span) }; }
    else { const name = this.expect("IDENT", "Expected pattern").lexeme; if (this.match("LPAREN")) { const parts: Node[] = []; while (!this.at("RPAREN") && !this.atEnd()) { parts.push(this.parsePattern()); if (!this.match("OP_,")) break; } const close = this.expect("RPAREN", "Expected )"); pattern = { kind: "ConstructorPattern", name, parts, span: this.join(start, close.span) }; } else if (this.match("LBRACE")) { const fields: Node[] = []; while (!this.at("RBRACE") && !this.atEnd()) { const fs = this.peek()!.span; if (this.match("OP_..")) { fields.push({ kind: "RestPattern", span: fs }); break; } const field = this.expect("IDENT", "Expected pattern field").lexeme; const sub = this.match("OP_:") ? this.parsePattern() : { kind: "BindingPattern", name: field, span: fs }; fields.push({ kind: "PatternField", name: field, pattern: sub, span: this.join(fs, (sub as any).span) }); if (!this.match("OP_,")) break; } const close = this.expect("RBRACE", "Expected }"); pattern = { kind: "StructPattern", name, fields, span: this.join(start, close.span) }; } else pattern = { kind: /^[A-Z]/.test(name) ? "VariantPattern" : "BindingPattern", name, span: this.join(start, this.previous()!.span) }; }
    if (this.match("OP_..") || this.match("OP_..=")) { const op = this.previous()!.lexeme, end = this.parsePattern(); pattern = { kind: "RangePattern", start: pattern, end, inclusive: op === "..=", span: this.join(start, (end as any).span) }; }
    while (this.match("OP_|")) { const right = this.parsePattern(); pattern = { kind: "OrPattern", left: pattern, right, span: this.join(start, (right as any).span) }; }
    return pattern;
  }
  private parsePath(): string { let path = this.expect("IDENT", "Expected type/name path").lexeme; while (this.match("OP_.")) path += "." + this.advance().lexeme; return path; }
  private parseStringAfterStart(start: Token): string { const parts = this.parseStringParts(); return parts.map((p: any) => p.kind === "StringText" ? p.value : "${...}").join(""); }
  private parseStringParts(): Node[] { const parts: Node[] = []; while (!this.at("STRING_END") && !this.atEnd()) { if (this.match("STRING_TEXT")) parts.push({ kind: "StringText", value: this.previous()!.value, span: this.previous()!.span }); else if (this.match("INTERP_START")) { const expr = this.parseExpression(); const close = this.expect("INTERP_END", "Expected } after interpolation"); parts.push({ kind: "Interpolation", expression: expr, span: this.join(this.previous()!.span, close.span) }); } else { this.report("E_STRING_TOKEN", "Unexpected token in string", this.peek()!.span); this.advance(); } } this.expect("STRING_END", "Expected end of string"); return parts; }
  private endStatement(): void { if (this.match("OP_;")) return; if (this.at("RBRACE") || this.atEnd()) return; if (this.peek()!.nl_before) return; }
  private skipNewlines(): void { /* newline boundaries are retained on tokens; list parsers consume by context */ }
  private canStartExpression(): boolean { return !!this.peek() && !["RBRACE", "RPAREN", "RBRACKET", "OP_;", "OP_,"].includes(this.peek()!.kind); }
  private synchronize(): void { while (!this.atEnd() && !this.at("OP_;") && !this.peek()!.nl_before && !this.at("RBRACE")) this.advance(); this.match("OP_;"); }
  private synchronizeBlock(): void { while (!this.atEnd() && !this.at("RBRACE") && !this.peek()!.nl_before) this.advance(); }
  private report(code: string, message: string, span: Span): void { this.diagnostics.push({ code, message, span }); }
  private join(a: Span, b: Span): Span { return { start: a.start, end: b.end, line: a.line, column: a.column, endLine: b.endLine, endColumn: b.endColumn }; }
  private at(kind: string): boolean { return this.peek()?.kind === kind; }
  private atEnd(): boolean { return this.i >= this.tokens.length; }
  private peek(offset = 0): Token | undefined { return this.tokens[this.i + offset]; }
  private previous(): Token | undefined { return this.tokens[this.i - 1]; }
  private advance(): Token { return this.tokens[this.i++]; }
  private match(kind: string): boolean { if (this.at(kind)) { this.advance(); return true; } return false; }
  private expect(kind: string, message: string): Token { if (this.at(kind)) return this.advance(); throw new Error(`${message}; found ${this.peek()?.lexeme ?? "end of input"}`); }
}

export function parse(source: string): { ast: Program; diagnostics: Diagnostic[]; lexed: LexResult } { const lexed = lex(source); const parser = new MinScriptParser(lexed); const ast = parser.parse(); return { ast, diagnostics: parser.diagnostics, lexed }; }
