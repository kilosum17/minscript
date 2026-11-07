package main

import "std.fs"
import "std.io"
import "std.crypto"

// Mode definition using structural string union types
pub type Mode = "encrypt" | "decrypt"

// Process an individual file based on the selected mode
async fun process_file(path: string, password: string, mode: Mode) -> Result<nil, string> {
    let file_bytes_res = await std.fs.read_file(path)
    // or file_bytes_res = await std.fs.read_file(path) or Err("Read failed: ${it.message}")
    let Result.Ok(data) = file_bytes_res else {
        return Result.Err("Failed to read file: ${path}")
    }

    match mode {
        "encrypt" => {
            let encrypted = std.crypto.encrypt_aes_gcm(data, password)
            let out_path = "${path}.enc"
            await std.fs.write_file(out_path, encrypted)
            println("Encrypted: ${path} -> ${out_path}")
        },
        "decrypt" => {
            let decrypted_res = std.crypto.decrypt_aes_gcm(data, password)
            let Ok(decrypted) = decrypted_res else {
                return Result.Err("Decryption failed (incorrect password or corrupted file): ${path}")
            }
            
            // strip_suffix returns string?, so we safely unwrap or fallback using .or()
            let out_path = path.strip_suffix(".enc").or(path)
            await std.fs.write_file(out_path, decrypted)
            println("Decrypted: ${path} -> ${out_path}")
        },
    }

    return Result.Ok(nil)
}

async fun main() {
    println("=== MinScript File Crypt Utility ===")
    
    print("Enter mode (encrypt / decrypt): ")
    // read_line() is async because stdin I/O blocks the thread
    let mode_input = (await std.io.read_line()).trim()
    
    if mode_input != "encrypt" and mode_input != "decrypt" {
        println("Invalid mode. Please select 'encrypt' or 'decrypt'.")
        return
    }

    print("Enter target file or directory path: ")
    let target_path = (await std.io.read_line()).trim()

    print("Enter password: ")
    let password = (await std.io.read_line()).trim()

    if password.length() == 0 {
        println("Password cannot be empty.")
        return
    }

    // Inspect target path
    let stat_res = await std.fs.stat(target_path)
    let Result.Ok(info) = stat_res else {
        println("Path does not exist or cannot be accessed: ${target_path}")
        return
    }

    if info.is_dir() {
        // Recursively walk directory to find files
        let files_res = await std.fs.walk_dir(target_path)
        let Result.Ok(files) = files_res else {
            println("Failed to read directory contents.")
            return
        }

        // Standard .map() works natively because async functions return a Promise<T> value
        let promises = files
            .filter(fun(file_path) {
                if mode_input == "encrypt" and file_path.ends_with(".enc") { return false }
                if mode_input == "decrypt" and not file_path.ends_with(".enc") { return false }
                return true
            })
            .map(fun(file_path) {
                return process_file(file_path, password, mode_input)
            })

        // Await all concurrent operations in a single go using Promise.all
        let results = await Promise.all(promises)

        // Handle any errors reported across the batch
        for res in results {
            let Result.Err(err_msg) = res else {
                continue
            }
            println("Warning: ${err_msg}")
        }
    } else {
        // Handle single file path
        let res = await process_file(target_path, password, mode_input)
        let Result.Err(err_msg) = res else {
            println("Operation completed successfully.")
            return
        }
        println("Error: ${err_msg}")
    }

    println("All operations completed.")
}
