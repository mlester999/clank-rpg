import { CARD_NAME_MAX, cardText, type HeroCardModel } from "@/domain/hero/card";
import type { ClassDef } from "@/domain/rules";

import type { Fighter } from "./characters";

/**
 * Builds the canonical public-safe card model from a loaded fighter. It SELECTS fields — it does not spread — so nothing else (Telegram id,
 * database id, seed, moderation state, wallet) can ever ride along.
 */
export function toHeroCardModel(p: { publicId: string; name: string; fighter: Pick<Fighter, "power" | "generatedStats" | "appearance" | "classId">; classDef: ClassDef; seasonRank?: string | null }): HeroCardModel {
  const { fighter, classDef } = p;
  return {
    publicId: p.publicId,
    name: cardText(p.name, CARD_NAME_MAX),
    classId: fighter.classId,
    className: classDef.name,
    rarity: fighter.appearance.rarity,
    power: fighter.power,
    stats: { ...fighter.generatedStats },
    seasonRank: p.seasonRank ?? null,
    look: {
      rarity: fighter.appearance.rarity,
      parts: fighter.appearance.parts,
      sprite: fighter.appearance.sprite,
      colors: [...classDef.look.colors] as [string, string, string],
      weapon: classDef.look.weapon,
      headgear: classDef.look.headgear,
      body: classDef.look.body,
    },
  };
}
