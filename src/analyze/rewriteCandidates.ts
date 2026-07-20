/**
 * リライト候補の抽出（§4-1）。
 *
 *  R1: 順位≤10 かつ CTR<3% かつ Imp≥200        （露出はあるがクリックされない）
 *  R2: 前期比で平均順位が3以上悪化 かつ 前期クリック≥10（稼いでいた記事の劣化）
 *  R3: 平均順位 11〜20 かつ Imp≥300              （2ページ目→1ページ目の押し上げ）
 *
 * スコア = インプレッション × 順位改善余地 で降順。
 * GA4の直帰傾向で重み付け（流入があるのに直帰が多い記事を優先）。
 * URL照合は必ず normalizeUrl() を通す。
 *
 * TODO(step5): 実装。
 */
import type { AnalyzeInput, Candidate } from "./types.ts";

export function extractRewriteCandidates(_input: AnalyzeInput): Candidate[] {
  throw new Error("not implemented (step5)");
}
