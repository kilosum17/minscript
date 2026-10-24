package main

import "std.fs"
import "std.io"
import "std.crypto"

// Mode definition using structural string union types
pub type Mode = "encrypt" | "decrypt"

// Custom result for cryptographic operations
pub type CryptoResult = 
    | Ok(Bytes)
    | Err(string)

// Process an individual file based on the selected mode
async fun process_file(path: string, password: string, mode: Mode) -> Result<nil, string> {
    const file_bytes_res = await std.fs.read_file(path)
    let Result.Ok(data) = file_bytes_res else {
        return Result.Err("Failed to read file: ${path}")
    }

    match mode {
        "encrypt" => {
            const encrypted = std.crypto.encrypt_aes_gcm(data, password)
            const out_path = "${path}.enc"
            await std.fs.write_file(out_path, encrypted)
            println("Encrypted: ${path} -> ${out_path}")
        },
        "decrypt" => {
            const decrypted_res = std.crypto.decrypt_aes_gcm(data, password)
            let CryptoResult.Ok(decrypted) = decrypted_res else {
                return Result.Err("Decryption failed (incorrect password or corrupted file): ${path}")
            }
            
            // strip_suffix returns string?, so we safely unwrap or fallback using .or()
            const out_path = path.strip_suffix(".enc").or(path)
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
    const mode_input = (await std.io.read_line()).trim()
    
    if mode_input != "encrypt" and mode_input != "decrypt" {
        println("Invalid mode. Please select 'encrypt' or 'decrypt'.")
        return
    }

    print("Enter target file or directory path: ")
    const target_path = (await std.io.read_line()).trim()

    print("Enter password: ")
    const password = (await std.io.read_line()).trim()

    if password.length() == 0 {
        println("Password cannot be empty.")
        return
    }

    // Inspect target path
    const stat_res = std.fs.stat(target_path)
    let Result.Ok(info) = stat_res else {
        println("Path does not exist or cannot be accessed: ${target_path}")
        return
    }

    if info.is_dir() {
        // Recursively walk directory to find files
        const files_res = std.fs.walk_dir(target_path)
        let Result.Ok(files) = files_res else {
            println("Failed to read directory contents.")
            return
        }

        // Standard .map() works natively because async functions return a Promise<T> value
        const promises = files
            .filter(fun(file_path) {
                if mode_input == "encrypt" and file_path.ends_with(".enc") { return false }
                if mode_input == "decrypt" and not file_path.ends_with(".enc") { return false }
                return true
            })
            .map(fun(file_path) {
                return process_file(file_path, password, mode_input)
            })

        // Await all concurrent operations in a single go using Promise.all
        const results = await Promise.all(promises)

        // Handle any errors reported across the batch
        for res in results {
            let Result.Err(err_msg) = res else {
                continue
            }
            println("Warning: ${err_msg}")
        }
    } else {
        // Handle single file path
        const res = await process_file(target_path, password, mode_input)
        let Result.Err(err_msg) = res else {
            println("Operation completed successfully.")
            return
        }
        println("Error: ${err_msg}")
    }

    println("All operations completed.")
}
