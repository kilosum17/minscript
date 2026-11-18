package
// main

// Runs on the JS back end; the output must match basics.out.
import "std.io"
import pub "std.build.*" as bld
import "std.fs" 
as fs2

type Point { x: int, y: int, fns r{} }
pub type Account {
    owner: str+1, 
    balance: i64, 
    tags: Vec[str],
    tags2:Vec[str]=[],
    note: str? 
}

type Point2 { 
    x: int,
    y: int 

    fn dist(this)->int{
        this.x + this.y
    }

}

union Shape{
    Circle { r: f64 }
    Rect(f64, f64)
    Empty = 0

    fn area(this) -> f64 {
        match this {
            Circle { r } => 3.0 * r * r
            Rect(w, h) => w * h
            Empty => 0.0
        }
    }
}
