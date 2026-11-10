package math

pub let pi: f64 = 3.141592653589793
pub let e: f64 = 2.718281828459045

pub fn abs[T: PartialOrd[T] & Default](x: T) -> T { _builtin() }
pub fn min[T: PartialOrd[T]](a: T, b: T) -> T { if b < a { b } else { a } }
pub fn max[T: PartialOrd[T]](a: T, b: T) -> T { if b > a { b } else { a } }
pub fn sqrt(x: f64) -> f64 { _builtin() }
pub fn pow(base: f64, exp: f64) -> f64 { _builtin() }
pub fn floor(x: f64) -> f64 { _builtin() }
pub fn ceil(x: f64) -> f64 { _builtin() }
pub fn round(x: f64) -> f64 { _builtin() }
pub fn sin(x: f64) -> f64 { _builtin() }
pub fn cos(x: f64) -> f64 { _builtin() }
