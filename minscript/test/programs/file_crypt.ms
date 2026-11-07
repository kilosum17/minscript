// Port of docs/history/samples/sam1.rs to v0.2 syntax.
package main

import "std.fs"
import "std.io"
import "std.crypto"

pub type Mode = "encrypt" | "decrypt"

// Process one file in the selected mode.
async fun process_file(path: string, password: string, mode: Mode) -> Result[void, string] {
    let data = await fs.read_file(path) or Err("Failed to read file: ${path}")

    match mode {
        "encrypt" => {
            let encrypted = crypto.encrypt_aes_gcm(data, password)
            let out_path = "${path}.enc"
            await fs.write_file(out_path, encrypted) or Err("Failed to write ${out_path}: ${it}")
            log.println("Encrypted: ${path} -> ${out_path}")
        }
        "decrypt" => {
            let decrypted = crypto.decrypt_aes_gcm(data, password)
                or Err("Decryption failed (incorrect password or corrupted file): ${path}")

            let out_path = path.strip_suffix(".enc")      // unchanged if there is no suffix
            await fs.write_file(out_path, decrypted) or Err("Failed to write ${out_path}: ${it}")
            log.println("Decrypted: ${path} -> ${out_path}")
        }
    }

    Ok()
}

async fun prompt(label: string) -> string {
    io.print(label)
    (await io.read_line()).trim()                          // &str → string (implicit copy)
}

async fun main() {
    log.println("=== MinScript File Crypt Utility ===")

    let mode_input = await prompt("Enter mode (encrypt / decrypt): ")
    let mode: Mode = match mode_input {
        "encrypt" => "encrypt"
        "decrypt" => "decrypt"
        _ => {
            log.println("Invalid mode. Please select 'encrypt' or 'decrypt'.")
            return
        }
    }

    let target_path = await prompt("Enter target file or directory path: ")
    let password = await prompt("Enter password: ")
    if password.is_empty() {
        log.println("Password cannot be empty.")
        return
    }

    let info = await fs.stat(target_path) or {
        log.println("Path does not exist or cannot be accessed: ${target_path}")
        return
    }

    if info.is_dir() {
        let files = await fs.walk_dir(target_path) or {
            log.println("Failed to read directory contents.")
            return
        }

        // Each process_file call schedules a task immediately; owned args, so no await needed here.
        let promises = files
            .filter(#{ f =>
                match mode {
                    "encrypt" => !f.ends_with(".enc")
                    "decrypt" => f.ends_with(".enc")
                }
            })
            .map(#{ f => process_file(f, password, mode) })

        let results = await Promise.all(promises)

        for res in results {
            if let Err(msg) = res {
                log.println("Warning: ${msg}")
            }
        }
    } else {
        let res = await process_file(target_path, password, mode)
        if let Err(msg) = res {
            log.println("Error: ${msg}")
            return
        }
        log.println("Operation completed successfully.")
    }

    log.println("All operations completed.")
}
