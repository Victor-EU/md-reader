/** Seeded PRNG (mulberry32) so every corpus failure is reproducible from its seed. */
export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
  };
}

/** Mix a seed with indices so each (file, action) pair gets its own stream. */
export function mixSeed(seed: number, ...parts: number[]): number {
  let h = seed >>> 0;
  for (const p of parts) h = Math.imul(h ^ (p + 0x9e3779b9), 0x85ebca6b) >>> 0;
  return h;
}
