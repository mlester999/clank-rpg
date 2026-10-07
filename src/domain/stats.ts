export const STAT_KEYS = ["hp", "str", "def", "int", "agi", "cha", "luck"] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type StatBlock = Record<StatKey, number>;

export const STAT_LABELS: Record<StatKey, string> = {
  hp: "HP",
  str: "STR",
  def: "DEF",
  int: "INT",
  agi: "AGI",
  cha: "CHA",
  luck: "LUCK",
};

export const zeroStats = (): StatBlock => ({ hp: 0, str: 0, def: 0, int: 0, agi: 0, cha: 0, luck: 0 });

export function addStats(...blocks: ReadonlyArray<Partial<StatBlock> | null | undefined>): StatBlock {
  const out = zeroStats();
  for (const block of blocks) {
    if (!block) continue;
    for (const key of STAT_KEYS) out[key] += block[key] ?? 0;
  }
  return out;
}

export function mapStats(block: StatBlock, fn: (value: number, key: StatKey) => number): StatBlock {
  const out = zeroStats();
  for (const key of STAT_KEYS) out[key] = fn(block[key], key);
  return out;
}

export const roundStats = (block: StatBlock): StatBlock => mapStats(block, (v) => Math.round(v));

export function sumStats(block: Partial<StatBlock>, exclude: readonly StatKey[] = []): number {
  let total = 0;
  for (const key of STAT_KEYS) if (!exclude.includes(key)) total += block[key] ?? 0;
  return total;
}
