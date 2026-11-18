#!/usr/bin/env python3
"""Generates minscript.tmLanguage.json (run: python3 syntaxes/build-grammar.py).

The grammar follows spec §1 (lexical structure) of the v0.4 spec. Keep it in sync with
src/token.ts and src/lexer.ts.
"""
import json, os

KEYWORDS_DECL = "package|import|pub|type|union|inter|impl|fn|async|let|var|extern"
KEYWORDS_CONTROL = "if|else|match|select|for|in|break|continue|return|await|or|as|lock"
KEYWORDS_OTHER = "unsafe|recover"
# removed in v0.4 (`fun` is `fn`; `mut` is gone) and reserved (§1.4): lexed as keywords, reported
REMOVED = "fun|mut"
RESERVED = "while|loop|yield|macro|where|dyn|thread|atomic"
PRIMITIVES = "bool|char|i8|i16|i32|i64|u8|u16|u32|u64|isize|usize|int|f32|f64|void|never|str"
ESCAPE = r"\\(?:[nrt0\\\"'$]|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\})"
BYTE_ESCAPE = r"\\(?:[nrt0\\\"']|x[0-9a-fA-F]{2})"

grammar = {
    "$schema": "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
    "name": "MinScript",
    "scopeName": "source.minscript",
    "fileTypes": ["ms"],
    "patterns": [{"include": "#code"}],
    "repository": {
        "code": {"patterns": [
            {"include": "#comments"},
            {"include": "#attributes"},
            {"include": "#strings"},
            {"include": "#chars"},
            {"include": "#numbers"},
            {"include": "#declarations"},
            {"include": "#members"},
            {"include": "#modes"},
            {"include": "#sigils"},
            {"include": "#modifiers"},
            {"include": "#keywords"},
            {"include": "#labels"},
            {"include": "#types"},
            {"include": "#calls"},
            {"include": "#identifiers"},
            {"include": "#operators"},
            {"include": "#braces"},
            {"include": "#punctuation"},
        ]},

        "comments": {"patterns": [
            {"name": "comment.line.documentation.minscript", "match": r"///(?!/).*$"},
            {"name": "comment.line.double-slash.minscript", "match": r"//.*$"},
            {"include": "#block-comment"},
        ]},
        "block-comment": {
            "name": "comment.block.minscript",
            "begin": r"/\*", "end": r"\*/",
            "patterns": [{"include": "#block-comment"}],      # block comments nest (§1.2)
        },

        # `#[effects(keeps: [v])]` on its own line, before an item or member (§8.6)
        "attributes": {"patterns": [{
            "name": "meta.attribute.minscript",
            "begin": r"^\s*(#\[)\s*([A-Za-z_]\w*)", "end": r"\]",
            "beginCaptures": {"1": {"name": "punctuation.definition.attribute.minscript"}, "2": {"name": "entity.name.function.attribute.minscript"}},
            "endCaptures": {"0": {"name": "punctuation.definition.attribute.minscript"}},
            "patterns": [{"include": "#code"}],
        }]},

        "strings": {"patterns": [
            {
                "name": "string.quoted.triple.minscript",
                "begin": r'"""', "end": r'"""',
                "patterns": [{"include": "#escape"}, {"include": "#interpolation"}],
            },
            {
                "name": "string.quoted.raw.minscript",
                "begin": r'(?<![\w.])(r)(")', "end": r'"',
                "beginCaptures": {"1": {"name": "storage.type.string.minscript"}, "2": {"name": "punctuation.definition.string.begin.minscript"}},
                "endCaptures": {"0": {"name": "punctuation.definition.string.end.minscript"}},
            },
            {
                "name": "string.quoted.double.minscript",
                "begin": r'"', "end": r'"|$',               # single-line strings end at the line end (§1.5)
                "beginCaptures": {"0": {"name": "punctuation.definition.string.begin.minscript"}},
                "endCaptures": {"0": {"name": "punctuation.definition.string.end.minscript"}},
                "patterns": [{"include": "#escape"}, {"include": "#interpolation"}],
            },
        ]},
        "escape": {"patterns": [
            {"name": "constant.character.escape.minscript", "match": ESCAPE},
            {"name": "invalid.illegal.escape.minscript", "match": r"\\."},
        ]},
        "interpolation": {
            "name": "meta.interpolation.minscript",
            "begin": r"\$\{", "end": r"\}",
            "beginCaptures": {"0": {"name": "punctuation.section.interpolation.begin.minscript"}},
            "endCaptures": {"0": {"name": "punctuation.section.interpolation.end.minscript"}},
            "contentName": "source.minscript.embedded",
            "patterns": [{"include": "#code"}],          # nested braces are matched by #braces, so `}` inside doesn't end it
        },

        "chars": {"patterns": [
            # byte literals `b'x'` (§1.6): ASCII or a byte escape, glued to the `b`
            {
                "match": r"(?<![\w.])(b)('(?:" + BYTE_ESCAPE + r"|[\x00-\x7f&&[^'\\]])')",
                "captures": {"1": {"name": "storage.type.byte.minscript"}, "2": {"name": "constant.character.byte.minscript"}},
            },
            {"name": "constant.character.minscript", "match": r"'(?:" + ESCAPE + r"|[^'\\])'"},
        ]},

        "numbers": {"patterns": [
            {"name": "constant.numeric.hex.minscript", "match": r"\b0x[0-9a-fA-F][0-9a-fA-F_]*\b"},
            {"name": "constant.numeric.binary.minscript", "match": r"\b0b[01][01_]*\b"},
            {"name": "constant.numeric.octal.minscript", "match": r"\b0o[0-7][0-7_]*\b"},
            # after a member `.`, only digits: `t.0.1` is tuple indexing (§1.5)
            {"name": "constant.numeric.integer.minscript", "match": r"(?<=\.)\d+"},
            {"name": "constant.numeric.float.minscript", "match": r"\b\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d[\d_]*)?\b"},
            {"name": "constant.numeric.float.minscript", "match": r"\b\d[\d_]*[eE][+-]?\d[\d_]*\b"},
            {"name": "constant.numeric.integer.minscript", "match": r"\b\d[\d_]*\b"},
        ]},

        "declarations": {"patterns": [
            {
                "match": r"\b(fn)\s+([A-Za-z_]\w*)",
                "captures": {"1": {"name": "storage.type.function.minscript"}, "2": {"name": "entity.name.function.minscript"}},
            },
            {
                "match": r"\b(type|union|inter)\s+([A-Za-z_]\w*)",
                "captures": {"1": {"name": "storage.type.minscript"}, "2": {"name": "entity.name.type.minscript"}},
            },
            {
                "match": r"\b(package)\s+([A-Za-z_][\w.]*)",
                "captures": {"1": {"name": "keyword.other.package.minscript"}, "2": {"name": "entity.name.namespace.minscript"}},
            },
        ]},

        # a keyword after `.` or `?.` is a plain name (§1.4)
        "members": {"patterns": [
            {"name": "entity.name.function.member.minscript", "match": r"(?<=\.)[A-Za-z_]\w*(?=\s*(?:\(|\.\[))"},
            {"name": "variable.other.member.minscript", "match": r"(?<=\.)[a-z_]\w*"},
        ]},

        # `*this` and `x: *T`: the write mode of a receiver, parameter or result (§8.3)
        "modes": {"patterns": [
            {"name": "storage.modifier.write.minscript", "match": r"\*(?=this\b)"},
            {"name": "storage.modifier.write.minscript", "match": r"(?<=:\s|->\s|:|->)\*(?=\s*[A-Za-z_(])"},
        ]},

        "sigils": {"patterns": [
            {"name": "keyword.operator.closure.minscript", "match": r"#(?=\{)"},
            {"name": "invalid.deprecated.capture-list.minscript", "match": r"#(?=\[)"},
            {"name": "storage.modifier.sigil.minscript", "match": r"(?<![\w.])(?:[rms_](?=\{)|t(?=\()|a(?=\[))"},
            {"name": "punctuation.accessor.generic.minscript", "match": r"\.(?=\[)"},
        ]},

        # `shared` and `once` are contextual keywords (§1.4): before a field, `var` / `let`, or a name and `:`
        "modifiers": {"patterns": [
            {"name": "storage.modifier.minscript", "match": r"\b(?:shared|once)\b(?=\s+(?:var\b|let\b|[A-Za-z_]\w*\s*:))"},
        ]},

        "keywords": {"patterns": [
            {"name": "keyword.other.declaration.minscript", "match": r"\b(?:" + KEYWORDS_DECL + r")\b"},
            {"name": "keyword.control.minscript", "match": r"\b(?:" + KEYWORDS_CONTROL + r")\b"},
            {"name": "keyword.other.minscript", "match": r"\b(?:" + KEYWORDS_OTHER + r")\b"},
            {"name": "constant.language.minscript", "match": r"\b(?:true|false|nil)\b"},
            {"name": "variable.language.this.minscript", "match": r"\b(?:this|Self)\b"},
            {"name": "invalid.deprecated.removed.minscript", "match": r"\b(?:" + REMOVED + r")\b"},
            {"name": "invalid.deprecated.reserved.minscript", "match": r"\b(?:" + RESERVED + r")\b"},
            {"name": "support.type.typeof.minscript", "match": r"\bTypeOf\b"},
        ]},

        "labels": {"patterns": [
            {"name": "entity.name.label.minscript", "match": r"\b[a-z_]\w*(?=:\s*for\b)"},
        ]},

        "types": {"patterns": [
            {"name": "support.type.primitive.minscript", "match": r"\b(?:" + PRIMITIVES + r")\b"},
            {"name": "entity.name.type.minscript", "match": r"\b[A-Z]\w*\b"},
        ]},

        "calls": {"patterns": [
            {"name": "entity.name.function.call.minscript", "match": r"\b[a-z_]\w*(?=\s*(?:\(|\.\[))"},
        ]},

        "identifiers": {"patterns": [
            {"name": "variable.language.implicit.minscript", "match": r"\bit(?:[1-9]\d*)?\b"},
            {"name": "variable.other.minscript", "match": r"\b[a-z_]\w*\b"},
        ]},

        "operators": {"patterns": [
            {"name": "keyword.operator.binding.minscript", "match": r":==|:="},
            {"name": "keyword.operator.nullish.minscript", "match": r"\?\?=?|\?\."},
            {"name": "keyword.operator.arrow.minscript", "match": r"=>|->"},
            {"name": "keyword.operator.range.minscript", "match": r"\.\.\.|\.\.=|\.\."},
            {"name": "keyword.operator.comparison.minscript", "match": r"==|!=|<=|>=|<|>"},
            {"name": "keyword.operator.logical.minscript", "match": r"&&|\|\||!"},
            {"name": "keyword.operator.assignment.minscript", "match": r"(?:<<|>>|[-+*/%&|^])?="},
            {"name": "keyword.operator.minscript", "match": r"<<|>>|[-+*/%&|^~?]"},
        ]},

        "braces": {
            "begin": r"\{", "end": r"\}",
            "beginCaptures": {"0": {"name": "punctuation.section.block.begin.minscript"}},
            "endCaptures": {"0": {"name": "punctuation.section.block.end.minscript"}},
            "patterns": [{"include": "#code"}],
        },

        "punctuation": {"patterns": [
            {"name": "punctuation.separator.minscript", "match": r"[,;:]"},
            {"name": "punctuation.accessor.minscript", "match": r"\."},
        ]},
    },
}

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "minscript.tmLanguage.json"), "w") as f:
    json.dump(grammar, f, indent=2)
    f.write("\n")
print("wrote minscript.tmLanguage.json")
