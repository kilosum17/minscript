package corpus

import "std.io.*"
import "std.io.{print, println}"
import "app.models" as models
import pub "./log"

pub let LIMIT = 10
let KEYWORDS = m{ sym("let"): Let } as Map[Symbol, TokenKind]
var counter = 0
pub shared var hits = 0

pub type User: Stringer {
    pub id: u64
    name: str
    email: str?
    tags: Vec[str] = []

    pub fn new(id: u64, name: str) -> User { User { id, name } }
    pub fn rename(*this, name: str) { this.name = name }
    fn to_str(this) -> str { "User(${this.id})" }
}

type Node: Identity { name: Symbol  once ty: Type  shared hits: int = 0 }

type Store {
    shared stock: Inventory
    pub shared takings: Money = Money.zero()
    pub once tier: Tier
    shared: int = 0
}

pub union Payment {
    Cash
    Mpesa(str)
    Card { number: str, exp: str }

    pub fn is_cash(this) -> bool { match this { Cash => true, _ => false } }
}

union P { Cash  Card { n: str }  fn is_cash(this) -> bool { true } }

pub inter Stringer { fn to_str(this) -> str }
inter R = A & B
inter PartialOrd[T]: PartialEq[T] { fn partial_cmp(this, o: T) -> Ordering? }
inter Refunder {
    async fn refund(*this, receipt: str) -> Result[void, str]
    fn can_refund(this, receipt: str) -> bool { receipt.starts_with("RCPT-") }
}

type Users = Vec[User]
type Role = "Admin" | "Operator" | "Guest"
type Point = r{ x: f64, y: f64 }
type Config = TypeOf(default_config)
type Tool = (Config) -> Config

impl User { fn extra(this) -> int { 1 } }
impl[T] Pair[T, T] { fn swap(*this) { } }
impl Plus, Minus for Money { fn plus(this, o: Money) -> Money { o } }

extern "C" { pub fn malloc(size: usize) -> unsafe.Ptr[u8] }

#[effects(keeps: [v], returns_view: [this.items])]
pub fn push(*this, v: T) { _builtin() }

fn f(u: *User, n: str) -> *Item { u.items[0] }
fn g(*this) { }
fn h(f: (*Item) -> int, g: () -> void) { }
pub async fn load[T: Unique](path: str, ...rest: str) -> Result[T, str] { }
fn yield() { }
fn largest[T: PartialOrd[T] & Copy](items: Vec[T]) -> T { items[0] }
