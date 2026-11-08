// The std packages on the JS back end: fs, env, time, math, json, crypto, io.
package main

import "std.fs"
import "std.env"
import "std.time"
import "std.math"
import "std.json"
import "std.crypto"
import "std.io"

type Point = { x: f64, y: f64, label: string? }

async fun files() {
    let dir = "${env.get("TMPDIR") ?? "/tmp"}/minscript-std-test"
    await fs.create_dir("${dir}/inner") or e => { log.error("${e}"); return }
    await fs.write_text("${dir}/a.txt", "alpha") or return
    await fs.write_text("${dir}/inner/b.txt", "beta") or return

    let text = await fs.read_text("${dir}/a.txt") or return
    log.println("read: ${text}")
    let info = await fs.stat("${dir}/inner") or return
    log.println("inner is a dir: ${info.is_dir()}")

    let all = await fs.walk_dir(dir) or return
    names := all.map(#{ p => p.strip_prefix(dir) })
    log.println("walk: ${names}")

    let missing = await fs.read_text("${dir}/nope.txt")
    if let Err(e) = missing { log.println("missing: ${e.message}") }

    await fs.remove(dir) or return
    log.println("exists after remove: ${await fs.exists(dir)}")
}

async fun main() {
    await files()

    env.set("MINSCRIPT_TEST", "on")
    log.println("env: ${env.get("MINSCRIPT_TEST") ?? "unset"}, args: ${env.args().len()}")

    let start = time.Instant.now()
    await time.sleep(5)
    log.println("slept: ${start.elapsed().ms >= 4}")

    log.println("math: ${math.sqrt(16.0)} ${math.abs(-3)} ${math.max(2, 7)} ${math.pi > 3.14}")

    let p = json.parse.[Point]("{\"x\": 1.5, \"y\": 2}") or e => {
        log.error("${e}")
        return
    }
    log.println("point: ${p.x} ${p.y} ${p.label ?? "no label"}")
    log.println("json: ${json.stringify(p)}")
    let pts = json.parse.[Vec[Point]]("[{\"x\": 0, \"y\": 0, \"label\": \"origin\"}]") or return
    log.println("first label: ${pts[0].label ?? "-"}")
    if let Err(e) = json.parse.[Point]("[1]") { log.println("shape error: ${e.message}") }

    let secret = "top secret".bytes()
    let sealed = crypto.encrypt_aes_gcm(secret, "pw")
    let opened = crypto.decrypt_aes_gcm(sealed, "pw") or return
    log.println("crypto: ${opened.len()} bytes back, wrong password fails: ${crypto.decrypt_aes_gcm(sealed, "no").is_err()}")
    log.println("sha256: ${crypto.sha256("abc".bytes()).substring(0, 12)}")

    io.print("io: ")
    io.println("one", 2, 3.5)
}
