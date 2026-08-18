export const MINIMAX_CURRENT_MUSIC_MODELS = ["music-3.0-free", "music-3.0"] as const;

export type MiniMaxCurrentMusicModel = typeof MINIMAX_CURRENT_MUSIC_MODELS[number];
export type MiniMaxMusicModel = MiniMaxCurrentMusicModel | "music-2.6-free" | "music-2.6";

export const MINIMAX_BATCH_MODELS = ["music-3.0-free", "music-2.6-free"] as const;
export type MiniMaxBatchModel = typeof MINIMAX_BATCH_MODELS[number];

export const MINIMAX_MUSIC_MODEL_LABELS: Record<MiniMaxMusicModel, string> = {
  "music-3.0-free": "Music 3.0 免费版",
  "music-3.0": "Music 3.0 付费版",
  "music-2.6-free": "Music 2.6 免费版",
  "music-2.6": "Music 2.6 付费版",
};

export function getMiniMaxComparisonModel(model: MiniMaxCurrentMusicModel): MiniMaxMusicModel {
  return model === "music-3.0" ? "music-2.6" : "music-2.6-free";
}
