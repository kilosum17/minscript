import type { Span } from "../lexer.ts";

export interface Node { kind: string; span: Span; [key: string]: any }
export interface Program extends Node { kind: "Program"; items: Node[] }
export interface TypeNode extends Node { kind: "Type"; form: string; name?: string; args?: Array<TypeNode | number>; inner?: TypeNode; members?: TypeNode[]; fields?: Node[]; params?: TypeNode[]; result?: TypeNode; mutable?: boolean }
export interface Expr extends Node {}
export interface Stmt extends Node {}
export interface Diagnostic { code: string; message: string; span: Span }
