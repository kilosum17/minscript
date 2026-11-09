// No mod.ms and no ./src: the folder itself is `main` (spec §17.6), with every `package main` file.
package main

fn main() {
    log.println("${twice(21)}")
}
