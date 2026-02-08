/// Utility functions

/// Check if a number is a power of 2
#[inline(always)]
pub fn is_power_of_2(n: usize) -> bool {
    n > 0 && (n & (n - 1)) == 0
}

/// Fast integer division by 16 (chunk size)
#[inline(always)]
pub fn div_16(x: i32) -> i32 {
    x >> 4
}

/// Fast modulo 16
#[inline(always)]
pub fn mod_16(x: i32) -> i32 {
    x & 15
}

/// Fast floor division
#[inline(always)]
pub fn floor_div(x: i32, y: i32) -> i32 {
    if x >= 0 {
        x / y
    } else {
        (x - y + 1) / y
    }
}
