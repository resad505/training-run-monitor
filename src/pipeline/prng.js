/**
 * Mulberry32 — a fast, deterministic 32-bit PRNG seeded with a single uint32.
 *
 * Returns a factory: given a seed, returns a `next()` function that yields
 * floats in [0, 1) with good statistical properties for simulation work.
 *
 * @param {number} seed - Unsigned 32-bit integer seed (0–4 294 967 295).
 * @returns {{ next: () => number, nextInt: (lo: number, hi: number) => number }}
 */
export function mulberry32(seed) {
  // Coerce to uint32 so the seed is always in range.
  let s = seed >>> 0

  /**
   * Advance the state and return a float in [0, 1).
   * @returns {number}
   */
  function next() {
    s = (s + 0x6d2b79f5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }

  /**
   * Return a random integer in the closed interval [lo, hi].
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  function nextInt(lo, hi) {
    return lo + Math.floor(next() * (hi - lo + 1))
  }

  return { next, nextInt }
}
