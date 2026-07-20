/**
 * 新規記事候補の抽出（§4-2）。
 *
 *  N1: クエリImp≥100 かつ 受け皿が専用記事でない（トップ/カテゴリページ等）
 *  N2: 既存記事に流入する複数クエリのうち検索意図が明確に別のもの（意図の分離）
 *
 * 判定が曖昧なもの（N2など）はClaude APIに
 * 「新規記事を書くべきか / 既存記事のリライトで対応すべきか」を判断させるステップを挟む。
 * 過去に提案済みのクエリ/類似クエリは履歴でスキップ。
 *
 * TODO(step5): 実装。
 */
import type { AnalyzeInput, Candidate } from "./types.ts";

export async function extractNewArticleCandidates(_input: AnalyzeInput): Promise<Candidate[]> {
  throw new Error("not implemented (step5)");
}
