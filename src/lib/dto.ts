// Type-only re-exports so client components share the server's DTO shapes (erased at build time).
export type {
  ArenaStateDto,
  BattleDto,
  CharacterDto,
  ClassVisual,
  FighterDto,
  PicksRewardDto,
  ReplayDto,
  ResultRowDto,
  UpcomingBattleDto,
  UpcomingFighterDto,
  UpcomingPicksDto,
} from "@/server/services/views";
export type { LeaderboardRow } from "@/server/services/leaderboard";
export type { InventoryItemView } from "@/server/services/inventory";
