// The std packages' builtins on the JS back end (spec §14.4): the functions of `std/**` whose body is
// `_builtin()`, keyed by their HIR name (`std.fs.read_text`, `std.net.ws.Reader.receive`). Importing
// this module installs them in the runtime's table; `run.ts` and `exec.ts` do.
//
// Values are the runtime's: strings, numbers (`int`) and BigInts (`i64`), `Vec` arrays, `MsMap`,
// `Some` / `None`, `Ok` / `Err`, and instances of the generated classes (`make("std.fs.Stat", …)`).
// Opaque std objects (servers, connections) are field-less classes carrying hidden JS state.

import * as childProcess from "node:child_process";
import * as nodeCrypto from "node:crypto";
import { promises as fsp } from "node:fs";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
    builtins, cell, classOf, describe, err, make, map, MsMap, MsPromise, MsSet, None, ok, opt, panic, Rec, show, some, spawn,
    substDesc, Tup, tup, variant, vec, Vec, waitFor, Cell, Some, NoneC, Ok, Err, type Desc, rec, set, aw, after, exitRequest,
} from "./runtime.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let programArgs: string[] = [];
/** The program's command-line arguments (`env.args()`). */
export function setArgs(args: string[]): void {
    programArgs = args;
}

let evaluatingConfig = false;
/** While mod.ms's `config()` runs, `build.run` is E_SCRIPT_IN_EVAL (§17.3). */
export function setEvaluating(on: boolean): void {
    evaluatingConfig = on;
}

const line = (args: Any) => [...args].map((a: Any) => show(a)).join(" ");
const okVoid = () => ok(undefined);
const bytes = (b: Any): Uint8Array => Uint8Array.from([...b].map(Number));
const toVec = (b: Uint8Array | Buffer) => vec(...b);

// ---- stdin, line by line (`io.read_line`) ----------------------------------------------------------

const stdin = { lines: [] as string[], waiting: [] as ((l: string) => void)[], closed: false, started: false };
function readLine(): MsPromise {
    return spawn(async () => {
        if (!stdin.started) {
            stdin.started = true;
            const { createInterface } = await import("node:readline");
            const rl = createInterface({ input: process.stdin, terminal: false });
            rl.on("line", (l) => {
                const w = stdin.waiting.shift();
                if (w) w(l);
                else stdin.lines.push(l);
            });
            rl.on("close", () => {
                stdin.closed = true;
                for (const w of stdin.waiting.splice(0)) w("");
            });
        }
        const l = stdin.lines.shift();
        if (l !== undefined) return l;
        if (stdin.closed) return "";
        return await new Promise<string>((r) => stdin.waiting.push(r));
    });
}

// ---- fs ----------------------------------------------------------------------------------------------

const fsErr = (path: string, e: unknown) =>
    err(make("std.fs.Error", { path, message: e instanceof Error ? ((e as NodeJS.ErrnoException).code ?? e.message) : String(e) }));
const fsTask = (path: string, body: () => Promise<Any>) =>
    spawn(async () => {
        try {
            return await body();
        } catch (e) {
            return fsErr(path, e);
        }
    });

// ---- runtime.run_module: a compiled ES module in a child process ----------------------------------

async function runModuleResult(js: string, args: Any, capture: boolean): Promise<Any> {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "minscript-module-"));
    const file = join(dir, "main.mjs");
    const resultFile = join(dir, "result");
    writeFileSync(file, js);
    const exec = fileURLToPath(new URL("./exec.ts", import.meta.url));
    try {
        let stdout = "";
        const code = await new Promise<number>((resolve) => {
            const child = childProcess.spawn(process.execPath, [exec, file, ...[...args].map(String)], {
                stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"],
                env: { ...process.env, MS_EXEC_RESULT: resultFile },
            });
            if (capture) {
                child.stdout!.setEncoding("utf8");
                child.stdout!.on("data", (c: string) => (stdout += c));
            }
            child.on("close", (c) => resolve(c ?? 1));
        });
        let value = 0;
        try {
            value = Number(readFileSync(resultFile, "utf8")) || 0;
        } catch {
            // it didn't finish
        }
        return make("std.runtime.ModuleResult", { code, value, stdout });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- JSON (§14.4): values ↔ JSON data, driven by type descriptors -----------------------------------

class JsonShapeError extends Error {}

const VALUE = "std.json.Value";
const jv = (name: string, ...f: Any[]) => variant(VALUE, name, ...f);

/** Plain JSON data as a `json.Value` tree. */
function jsonValue(v: Any): Any {
    if (v === null || v === undefined) return jv("Null");
    if (typeof v === "boolean") return jv("Bool", v);
    if (typeof v === "number") return jv("Number", v);
    if (typeof v === "string") return jv("Str", v);
    if (Array.isArray(v)) return jv("Array", vec(...v.map(jsonValue)));
    return jv("Object", map(...Object.entries(v).map(([k, x]) => [k, jsonValue(x)] as [Any, Any])));
}

/** A value as plain JSON data (what `stringify` writes). */
export function toJson(v: Any): Any {
    if (v === undefined || v === null) return null;
    if (typeof v === "bigint") return Number(v);
    if (typeof v !== "object") return v;
    if (v instanceof Cell) return toJson(v.v);
    if (v instanceof Some) return toJson(v.v);
    if (v instanceof NoneC) return null;
    if (v instanceof Ok) return { Ok: [toJson(v.v)] };
    if (v instanceof Err) return { Err: [toJson(v.e)] };
    if (v instanceof Vec || v instanceof Tup || Array.isArray(v)) return [...v].map(toJson);
    if (v instanceof MsSet) return [...v.m.values()].map(toJson);
    if (v instanceof MsMap) return Object.fromEntries([...v.m.values()].map(([k, x]) => [typeof k === "string" ? k : show(k), toJson(x)]));
    if (v instanceof Rec) return Object.fromEntries(Object.keys(v).filter((k) => k !== "$s").sort().map((k) => [k, toJson(v[k])]));
    const proto = Object.getPrototypeOf(v);
    if (proto?.$v !== undefined && classOf(`${VALUE}.${proto.$v}`) === proto.constructor) {
        if (proto.$v === "Null") return null;
        if (proto.$v === "Array") return [...v.$0].map(toJson);
        if (proto.$v === "Object") return Object.fromEntries([...v.$0.m.values()].map(([k, x]: [Any, Any]) => [k, toJson(x)]));
        return toJson(v.$0);
    }
    if (proto?.$v !== undefined) {
        const fields: string[] = proto.$f ?? [];
        return fields.length === 0 ? proto.$v : { [proto.$v]: fields.map((f) => toJson(v[f])) };
    }
    const out: Any = {};
    for (const f of (proto?.$f as string[] | undefined) ?? Object.keys(v)) if (v[f] !== undefined) out[f] = toJson(v[f]);
    return out;
}

const INTS = new Set(["int", "i8", "i16", "i32", "u8", "u16", "u32", "isize", "usize"]);

/** Plain JSON data → a value of the type `d` (`json.parse.[User]`). */
function fromJson(v: Any, d: Desc, at: string): Any {
    const where = at === "" ? "" : ` at \`${at}\``;
    const isOption = d !== null && "n" in d && d.n === "prelude.Option";
    if (isOption) return v === null || v === undefined ? None : some(fromJson(v, (d as { a: Desc[] }).a[0] ?? null, at));
    if (v === undefined) throw new JsonShapeError(`missing field${where}`);
    if (d === null) return v === null ? undefined : Array.isArray(v) ? vec(...v.map((x) => fromJson(x, null, at))) : v;
    if ("p" in d) {
        if (d.p === "bool") {
            if (typeof v !== "boolean") throw new JsonShapeError(`expected a bool${where}`);
            return v;
        }
        if (d.p === "str" || d.p === "char") {
            if (typeof v !== "string") throw new JsonShapeError(`expected a string${where}`);
            return v;
        }
        if (d.p === "void") return undefined;
        if (typeof v !== "number") throw new JsonShapeError(`expected a number${where}`);
        if (d.p === "i64" || d.p === "u64") return BigInt(Math.trunc(v));
        if (INTS.has(d.p) && !Number.isInteger(v)) throw new JsonShapeError(`expected an integer${where}`);
        return v;
    }
    if ("t" in d) {
        if (!Array.isArray(v) || v.length !== d.t.length) throw new JsonShapeError(`expected an array of ${d.t.length}${where}`);
        return tup(...v.map((x, i) => fromJson(x, d.t[i] ?? null, `${at}[${i}]`)));
    }
    if ("r" in d) {
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new JsonShapeError(`expected an object${where}`);
        return rec(Object.fromEntries(Object.entries(d.r).map(([k, x]) => [k, fromJson(v[k], x, at === "" ? k : `${at}.${k}`)])));
    }
    if (!("n" in d)) return v;
    const elem = d.a[0] ?? null;
    switch (d.n) {
        case "prelude.Vec": case "prelude.Array": case "prelude.Slice": case "prelude.PVec":
            if (!Array.isArray(v)) throw new JsonShapeError(`expected an array${where}`);
            return vec(...v.map((x, i) => fromJson(x, elem, `${at}[${i}]`)));
        case "prelude.Set":
            if (!Array.isArray(v)) throw new JsonShapeError(`expected an array${where}`);
            return set(...v.map((x, i) => fromJson(x, elem, `${at}[${i}]`)));
        case "prelude.Map": case "prelude.PMap": {
            if (v === null || typeof v !== "object" || Array.isArray(v)) throw new JsonShapeError(`expected an object${where}`);
            const val = d.a[1] ?? null;
            return map(...Object.entries(v).map(([k, x]) => [k, fromJson(x, val, at === "" ? k : `${at}.${k}`)] as [Any, Any]));
        }
        case VALUE:
            return jsonValue(v);
    }
    const C = classOf(d.n);
    if (C) {
        // a struct: an object; a missing field takes its default, an optional one None
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw new JsonShapeError(`expected an object${where}`);
        const proto = C.prototype;
        const fields: Record<string, Any> = {};
        for (const f of proto.$f as string[]) {
            const fd = substDesc(proto.$ft?.[f] ?? null, d.a);
            let x: Any;
            if (v[f] === undefined && proto.$def?.[f]) x = proto.$def[f]();
            else if ((proto.$once ?? []).includes(f)) x = v[f] === undefined || v[f] === null ? undefined : fromJson(v[f], fd, at === "" ? f : `${at}.${f}`);
            else x = fromJson(v[f], fd, at === "" ? f : `${at}.${f}`);
            fields[f] = (proto.$cells ?? []).includes(f) ? cell(x) : x;
        }
        return make(d.n, fields);
    }
    // a union: `"Name"` or `{ "Name": [payload…] }`
    const [name, payload] = typeof v === "string" ? [v, []] : v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 ? Object.entries(v)[0]! : [null, null];
    const V = name === null ? undefined : classOf(`${d.n}.${name}`);
    if (!V) throw new JsonShapeError(`expected a variant of \`${describe(d)}\`${where}`);
    const keys: string[] = V.prototype.$f ?? [];
    const items: Any[] = Array.isArray(payload) ? payload : [payload];
    if (items.length !== keys.length) throw new JsonShapeError(`\`${name}\` has ${keys.length} payload value(s)${where}`);
    const fts: Desc[] = V.prototype.$ft ?? [];
    return new V(...items.map((x, i) => fromJson(x, substDesc(fts[i] ?? null, d.a), `${at}.${name}[${i}]`)));
}

const jsonErr = (message: string) => err(make("std.json.Error", { message }));
function decode(data: Any, w: Any): Any {
    try {
        return ok(fromJson(data, w?.d ?? null, ""));
    } catch (e) {
        if (e instanceof JsonShapeError) return jsonErr(e.message);
        throw e;
    }
}

// ---- resources a program opened (servers, sockets): closed when it ends ------------------------------

const openResources = new Set<{ close(): void }>();
export function closeResources(): void {
    for (const r of [...openResources]) {
        try {
            r.close();
        } catch {
            // already closed
        }
    }
    openResources.clear();
}

/** A queue whose `take` is cancel-safe: a value that loses a `select` goes back to the front. */
class Inbox {
    items: Any[] = [];
    waiters: ((v: Any) => void)[] = [];
    closedWith: Any = null;
    push(v: Any): void {
        const w = this.waiters.shift();
        if (w) w(v);
        else this.items.push(v);
    }
    close(final: Any): void {
        if (this.closedWith !== null) return;
        this.closedWith = final;
        for (const w of this.waiters.splice(0)) w(final);
    }
    take(): MsPromise {
        return waitFor((resolve) => {
            if (this.items.length > 0) {
                const v = this.items.shift();
                resolve(v);
                return () => this.items.unshift(v);
            }
            if (this.closedWith !== null) {
                resolve(this.closedWith);
                return () => {};
            }
            let got: Any;
            let done = false;
            const w = (v: Any) => {
                done = true;
                got = v;
                resolve(v);
            };
            this.waiters.push(w);
            return () => {
                if (!done) this.waiters = this.waiters.filter((x) => x !== w);
                else if (got !== this.closedWith) this.items.unshift(got);
            };
        });
    }
}

// ---- std.net.ws: WebSockets (RFC 6455) ----------------------------------------------------------------
// The server is a small implementation over node:http; the client is Node's global WebSocket.

const WS = "std.net.ws";
const wsErr = (message: string) => err(make(`${WS}.Error`, { message }));
const wsMsg = (name: "Text" | "Binary" | "Close", ...f: Any[]) => variant(`${WS}.Message`, name, ...f);
const msgKind = (m: Any): string => Object.getPrototypeOf(m)?.$v;

type WsConn = { inbox: Inbox; send(msg: Any): Promise<Any>; close(): void };

function frame(opcode: number, payload: Buffer): Buffer {
    const len = payload.length;
    let head: Buffer;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) head = Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
    else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([head, payload]);
}

function serverConn(socket: Socket): WsConn {
    const inbox = new Inbox();
    let buf = Buffer.alloc(0);
    let fragments: Buffer[] = [];
    let fragOpcode = 0;
    let open = true;
    const conn: WsConn = {
        inbox,
        send: (msg: Any) => {
            if (!open || socket.destroyed) return Promise.resolve(wsErr("connection closed"));
            const kind = msgKind(msg);
            if (kind === "Close") {
                conn.close();
                return Promise.resolve(okVoid());
            }
            const data = kind === "Text" ? Buffer.from(msg.$0, "utf8") : Buffer.from(bytes(msg.$0));
            return new Promise((r) => socket.write(frame(kind === "Text" ? 1 : 2, data), (e) => r(e ? wsErr(e.message) : okVoid())));
        },
        close: () => {
            if (!open) return;
            open = false;
            if (!socket.destroyed) socket.end(frame(8, Buffer.alloc(0)));
            inbox.close(ok(wsMsg("Close")));
            openResources.delete(conn);
        },
    };
    openResources.add(conn);
    socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            const fin = (buf[0]! & 0x80) !== 0;
            const opcode = buf[0]! & 0x0f;
            const masked = (buf[1]! & 0x80) !== 0;
            let len = buf[1]! & 0x7f;
            let at = 2;
            if (len === 126) {
                if (buf.length < 4) return;
                len = buf.readUInt16BE(2);
                at = 4;
            } else if (len === 127) {
                if (buf.length < 10) return;
                len = Number(buf.readBigUInt64BE(2));
                at = 10;
            }
            const maskAt = at;
            if (masked) at += 4;
            if (buf.length < at + len) return;
            const payload = Buffer.from(buf.subarray(at, at + len));
            if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= buf[maskAt + (i & 3)]!;
            buf = buf.subarray(at + len);
            if (opcode === 8) {
                conn.close();
                return;
            }
            if (opcode === 9) {
                socket.write(frame(10, payload));
                continue;
            }
            if (opcode === 10) continue;
            if (opcode !== 0) {
                fragOpcode = opcode;
                fragments = [];
            }
            fragments.push(payload);
            if (!fin) continue;
            const data = Buffer.concat(fragments);
            fragments = [];
            inbox.push(ok(fragOpcode === 1 ? wsMsg("Text", data.toString("utf8")) : wsMsg("Binary", toVec(data))));
        }
    });
    socket.on("close", () => {
        open = false;
        inbox.close(ok(wsMsg("Close")));
        openResources.delete(conn);
    });
    socket.on("error", () => {
        open = false;
        inbox.close(wsErr("connection reset"));
    });
    return conn;
}

function clientConn(url: string): Promise<Any> {
    return new Promise((resolve) => {
        let sock: Any;
        try {
            sock = new (globalThis as Any).WebSocket(url);
        } catch (e) {
            resolve(wsErr(e instanceof Error ? e.message : String(e)));
            return;
        }
        sock.binaryType = "arraybuffer";
        const inbox = new Inbox();
        let opened = false;
        const conn: WsConn = {
            inbox,
            send: async (msg: Any) => {
                if (sock.readyState !== 1) return wsErr("connection closed");
                const kind = msgKind(msg);
                if (kind === "Close") {
                    conn.close();
                    return okVoid();
                }
                sock.send(kind === "Text" ? msg.$0 : bytes(msg.$0));
                return okVoid();
            },
            close: () => {
                try {
                    sock.close();
                } catch {
                    // closed
                }
                inbox.close(ok(wsMsg("Close")));
                openResources.delete(conn);
            },
        };
        sock.onopen = () => {
            opened = true;
            openResources.add(conn);
            resolve(ok(make(`${WS}.Connection`, { $conn: conn })));
        };
        sock.onmessage = (e: Any) => inbox.push(ok(typeof e.data === "string" ? wsMsg("Text", e.data) : wsMsg("Binary", toVec(new Uint8Array(e.data)))));
        sock.onclose = () => {
            inbox.close(ok(wsMsg("Close")));
            openResources.delete(conn);
        };
        sock.onerror = () => {
            if (!opened) resolve(wsErr(`could not connect to ${url}`));
            else inbox.close(wsErr("connection error"));
        };
    });
}

// ---- std.net.http ------------------------------------------------------------------------------------

const HTTP = "std.net.http";
const httpErr = (message: string) => err(make(`${HTTP}.Error`, { message }));
const headerMap = (entries: Iterable<[string, string]>) => map(...[...entries].map(([k, v]) => [k.toLowerCase(), v] as [Any, Any]));

// ---- the table -----------------------------------------------------------------------------------------

Object.assign(builtins, {
    // io, log
    "std.io.println": (args: Any) => void process.stdout.write(line(args) + "\n"),
    "std.io.print": (args: Any) => void process.stdout.write(line(args)),
    "std.io.eprintln": (args: Any) => void process.stderr.write(line(args) + "\n"),
    "std.io.read_line": readLine,
    "std.log.println": (args: Any) => void process.stdout.write(line(args) + "\n"),
    "std.log.print": (args: Any) => void process.stdout.write(line(args)),
    "std.log.info": (args: Any) => void process.stdout.write(line(args) + "\n"),
    "std.log.debug": (args: Any) => void process.stderr.write("debug: " + line(args) + "\n"),
    "std.log.warn": (args: Any) => void process.stderr.write("warning: " + line(args) + "\n"),
    "std.log.error": (args: Any) => void process.stderr.write("error: " + line(args) + "\n"),

    // env
    "std.env.get": (k: string) => opt(process.env[k]),
    "std.env.set": (k: string, v: string) => void (process.env[k] = v),
    "std.env.args": () => vec(...programArgs),
    "std.env.cwd": () => process.cwd(),

    // math
    "std.math.abs": (x: Any) => (x < 0 ? -x : x),
    "std.math.sqrt": Math.sqrt,
    "std.math.pow": Math.pow,
    "std.math.floor": Math.floor,
    "std.math.ceil": Math.ceil,
    "std.math.round": Math.round,
    "std.math.sin": Math.sin,
    "std.math.cos": Math.cos,

    // utf8
    "std.utf8.decode": (b: Any) => new TextDecoder().decode(bytes(b)),
    "std.utf8.decode_range": (b: Any, start: number, end: number) => {
        const all = bytes(b);
        const lo = Math.max(0, Math.min(start, all.length));
        const hi = Math.max(lo, Math.min(end, all.length));
        return new TextDecoder().decode(all.subarray(lo, hi));
    },
    "std.utf8.encode": (s: string) => toVec(new TextEncoder().encode(s)),

    // runtime
    "std.runtime.yield": () => spawn(async () => aw(after(0))),
    "std.runtime.exit": (code: Any) => {
        throw exitRequest(Number(code));
    },
    "std.runtime.run_module": (js: string, args: Any) => spawn(async () => (await runModuleResult(js, args, false)).code),
    "std.runtime.run_module_result": (js: string, args: Any, capture: boolean) => spawn(() => runModuleResult(js, args, capture)),
    "std.runtime.shell": (cmd: string, dir: string) => childProcess.spawnSync(cmd, { shell: true, stdio: "inherit", cwd: dir }).status ?? 1,

    // crypto: AES-256-GCM, key from scrypt(password, salt); output = salt(16) | nonce(12) | tag(16) | ciphertext
    "std.crypto.encrypt_aes_gcm": (data: Any, password: string) => {
        const salt = nodeCrypto.randomBytes(16);
        const nonce = nodeCrypto.randomBytes(12);
        const cipher = nodeCrypto.createCipheriv("aes-256-gcm", nodeCrypto.scryptSync(password, salt, 32), nonce);
        const body = Buffer.concat([cipher.update(bytes(data)), cipher.final()]);
        return toVec(Buffer.concat([salt, nonce, cipher.getAuthTag(), body]));
    },
    "std.crypto.decrypt_aes_gcm": (data: Any, password: string) => {
        const buf = Buffer.from(bytes(data));
        if (buf.length < 44) return err("data too short to be encrypted");
        try {
            const d = nodeCrypto.createDecipheriv("aes-256-gcm", nodeCrypto.scryptSync(password, buf.subarray(0, 16), 32), buf.subarray(16, 28));
            d.setAuthTag(buf.subarray(28, 44));
            return ok(toVec(Buffer.concat([d.update(buf.subarray(44)), d.final()])));
        } catch {
            return err("wrong password, or the data is corrupted");
        }
    },
    "std.crypto.sha256": (data: Any) => nodeCrypto.createHash("sha256").update(bytes(data)).digest("hex"),
    "std.crypto.random_bytes": (n: Any) => toVec(nodeCrypto.randomBytes(Number(n))),

    // fs (every operation is async)
    "std.fs.read_file": (path: string) => fsTask(path, async () => ok(toVec(await fsp.readFile(path)))),
    "std.fs.read_text": (path: string) => fsTask(path, async () => ok(await fsp.readFile(path, "utf8"))),
    "std.fs.write_file": (path: string, data: Any) => fsTask(path, async () => (await fsp.writeFile(path, bytes(data)), okVoid())),
    "std.fs.write_text": (path: string, text: string) => fsTask(path, async () => (await fsp.writeFile(path, text), okVoid())),
    "std.fs.stat": (path: string) =>
        fsTask(path, async () => {
            const st = await fsp.stat(path);
            return ok(make("std.fs.Stat", { size: BigInt(st.size), dir: st.isDirectory(), modified: BigInt(Math.floor(st.mtimeMs)) }));
        }),
    "std.fs.exists": (path: string) => spawn(async () => fsp.stat(path).then(() => true, () => false)),
    "std.fs.list_dir": (path: string) => fsTask(path, async () => ok(vec(...(await fsp.readdir(path)).sort()))),
    "std.fs.walk_dir": (path: string) =>
        fsTask(path, async () => {
            const entries = await fsp.readdir(path, { recursive: true, withFileTypes: true });
            return ok(vec(...entries.filter((d) => d.isFile()).map((d) => `${d.parentPath}/${d.name}`.replace(/\/+/g, "/")).sort()));
        }),
    "std.fs.create_dir": (path: string) => fsTask(path, async () => (await fsp.mkdir(path, { recursive: true }), okVoid())),
    "std.fs.remove": (path: string) => fsTask(path, async () => (await fsp.rm(path, { recursive: true }), okVoid())),

    // json: the witness of `T` describes the type to build
    "std.json.parse": (text: string, w: Any) => {
        let data: Any;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return jsonErr(e instanceof Error ? e.message : String(e));
        }
        return decode(data, w);
    },
    "std.json.stringify": (v: Any) => JSON.stringify(toJson(v)),
    "std.json.to_value": (v: Any) => jsonValue(toJson(v)),
    "std.json.from_value": (v: Any, w: Any) => decode(toJson(v), w),

    // testing
    "std.testing.clock": () => BigInt(Date.now()),

    // unsafe
    "std.unsafe.Ptr.is_null": () => panic("User", "raw pointers aren't available on the JS back end"),

    // build (mod.ms)
    "build.current_target": () => {
        const os = ({ linux: "Linux", darwin: "MacOs", win32: "Windows", android: "Android" } as Record<string, string>)[process.platform] ?? "Other";
        return make("build.Target", { os: variant("build.Os", os), arch: process.arch, back_end: "js" });
    },
    "build.evaluate": (config: () => Any) => {
        const was = evaluatingConfig;
        evaluatingConfig = true;
        try {
            return config();
        } finally {
            evaluatingConfig = was;
        }
    },
    "build.run": (cmd: string) => {
        if (evaluatingConfig) panic("User", `E_SCRIPT_IN_EVAL: \`run(${JSON.stringify(cmd)})\` while mod.ms is being evaluated; scripts only run from \`ms run <name>\``);
        const r = childProcess.spawnSync(cmd, { shell: true, stdio: "inherit" });
        if (r.error) return err(r.error.message);
        return r.status === 0 ? okVoid() : err(`\`${cmd}\` failed with exit code ${r.status ?? "?"}`);
    },

    // std.net.ws
    "std.net.ws.listen": (host: string, port: Any) =>
        spawn(async () => {
            const h = await import("node:http");
            const accepted = new Inbox();
            const srv = h.createServer((_req, res) => void res.writeHead(426).end("WebSocket only"));
            const state = {
                accepted,
                port: () => (srv.address() as import("node:net").AddressInfo).port,
                close: () => {
                    srv.close();
                    accepted.close(wsErr("server closed"));
                    openResources.delete(state);
                },
            };
            srv.on("upgrade", (req, socket) => {
                const k = req.headers["sec-websocket-key"];
                if (typeof k !== "string") return void socket.destroy();
                const accept = nodeCrypto.createHash("sha1").update(k + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
                socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
                accepted.push(ok(make(`${WS}.Connection`, { $conn: serverConn(socket as Socket) })));
            });
            return await new Promise((resolve) => {
                srv.once("error", (e) => resolve(wsErr(`cannot listen on ${host}:${port}: ${e.message}`)));
                srv.listen(Number(port), host, () => {
                    openResources.add(state);
                    resolve(ok(make(`${WS}.Server`, { $srv: state })));
                });
            });
        }),
    "std.net.ws.connect": (url: string) => spawn(() => clientConn(url)),
    "std.net.ws.Server.accept": (s: Any) => s.$srv.accepted.take(),
    "std.net.ws.Server.close": (s: Any) => void s.$srv.close(),
    "std.net.ws.Server.port": (s: Any) => s.$srv.port(),
    "std.net.ws.Connection.split": (c: Any) => tup(make(`${WS}.Reader`, { $conn: c.$conn }), make(`${WS}.Writer`, { $conn: c.$conn })),
    "std.net.ws.Reader.receive": (r: Any) => r.$conn.inbox.take(),
    "std.net.ws.Writer.send": (w: Any, msg: Any) => spawn(() => w.$conn.send(msg)),

    // std.net.http: the server is node:http, the client the global fetch
    "std.net.http.listen": (host: string, port: Any) =>
        spawn(async () => {
            const h = await import("node:http");
            const accepted = new Inbox();
            const srv = h.createServer((req, res) => {
                const chunks: Buffer[] = [];
                req.on("data", (c: Buffer) => chunks.push(c));
                req.on("end", () => {
                    const url = new URL(req.url ?? "/", "http://localhost");
                    const headers = headerMap(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")] as [string, string]));
                    accepted.push(ok(make(`${HTTP}.Request`, {
                        method: req.method ?? "GET", path: url.pathname, query: headerMap(url.searchParams.entries()), headers,
                        body: Buffer.concat(chunks).toString("utf8"), $res: res,
                    })));
                });
            });
            const state = {
                accepted,
                port: () => (srv.address() as import("node:net").AddressInfo).port,
                close: () => {
                    srv.close();
                    srv.closeAllConnections?.();
                    accepted.close(httpErr("server closed"));
                    openResources.delete(state);
                },
            };
            return await new Promise((resolve) => {
                srv.once("error", (e) => resolve(httpErr(`cannot listen on ${host}:${port}: ${e.message}`)));
                srv.listen(Number(port), host, () => {
                    openResources.add(state);
                    resolve(ok(make(`${HTTP}.Server`, { $srv: state })));
                });
            });
        }),
    "std.net.http.Server.accept": (s: Any) => s.$srv.accepted.take(),
    "std.net.http.Server.close": (s: Any) => void s.$srv.close(),
    "std.net.http.Server.port": (s: Any) => s.$srv.port(),
    "std.net.http.Request.respond_with": (req: Any, r: Any) =>
        spawn(async () => {
            const res = req.$res as import("node:http").ServerResponse | undefined;
            if (!res || res.headersSent || res.writableEnded) return httpErr(res ? "this request was already answered" : "this request didn't come from a server");
            const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
            for (const [k, v] of r.headers.m.values() as Iterable<[string, string]>) headers[String(k).toLowerCase()] = v;
            return await new Promise((resolve) => {
                res.writeHead(Number(r.status), headers);
                res.end(r.body, () => resolve(okVoid()));
                res.once("error", (e) => resolve(httpErr(e.message)));
            });
        }),
    "std.net.http.send": (o: Any) =>
        spawn(async () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of o.headers.m.values() as Iterable<[string, string]>) headers[k] = v;
            try {
                const method = String(o.method).toUpperCase();
                const r = await fetch(o.url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : o.body });
                return ok(make(`${HTTP}.Response`, { status: r.status, headers: headerMap(r.headers.entries()), body: await r.text() }));
            } catch (e) {
                const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
                return httpErr(`${e instanceof Error ? e.message : String(e)}${cause}`);
            }
        }),
});
