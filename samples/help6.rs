

// Allows reading from a collection via index (e.g., let x = list[0])
pub inter Index<Idx, Target> = {
    pub fun index(this, index: Idx) -> &Target
}

// Allows getting a mutable reference to a slot (used for assignment)
pub inter IndexMut<Idx, Target> = {
    pub fun index_mut(mut this, index: Idx) -> &mut Target
}

// Allows in-place addition assignment (+=)
pub inter AddAssign<RHS> = {
    pub fun add_assign(mut this, rhs: RHS)
}


pub inter SubAssign<RHS> = {
    pub fun sub_assign(mut this, rhs: RHS)
}

pub inter MulAssign<RHS> = {
    pub fun mul_assign(mut this, rhs: RHS)
}

pub inter DivAssign<RHS> = {
    pub fun div_assign(mut this, rhs: RHS)
}

pub inter RemAssign<RHS> = {
    pub fun rem_assign(mut this, rhs: RHS)
}

pub inter Add<RHS, Output> = {
    pub fun add(this, rhs: RHS) -> Output
}

pub inter Sub<RHS, Output> = {
    pub fun sub(this, rhs: RHS) -> Output
}

pub inter Mul<RHS, Output> = {
    pub fun mul(this, rhs: RHS) -> Output
}

pub inter Div<RHS, Output> = {
    pub fun div(this, rhs: RHS) -> Output
}


// Enables `==` and `!=`
pub inter PartialEq<T> = {
    pub fun eq(this, other: T) -> bool
}

// Enables `<`, `<=`, `>`, `>=`
pub inter PartialOrd<T> : PartialEq<T> = {
    pub fun partial_cmp(this, other: T) -> Option<Ordering>
}

pub inter Len = {
    pub fun len(this) -> usize
}

pub inter Iterator<Item> = {
    pub fun next(mut this) -> Option<Item>
}

pub inter Iterable<Item> = {
    pub fun iter(this) -> Iterator<Item>
}


user_scores["alice"] += 50
// Desugared execution:
(*user_scores.index_mut("alice")).add_assign(50)// index_mut will panic for missing keys

var numbers = [1, 2, 3, 4]

// You write:
numbers[0] += 10

// Compiler desugars to:
(*numbers.index_mut(0)).add_assign(10)

// numbers is now [11, 2, 3, 4]
// Safely inserts 0 if "alice" doesn't exist, then applies the modification
user_scores.upsert("alice", 0, (score) => {
    score += 50
})

let config: Config = r{
    name:"Bob",
    skills:t("shopping", "walking")
}
 or 
pub type Config = Type(config)
pub type ConfigKeys = KeyOf<Config>

// tuples of the same structure are auto assigned the same type
