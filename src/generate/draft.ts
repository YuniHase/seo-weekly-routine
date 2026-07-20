/**
 * Claude API 呼び出しによるドラフト生成（§5）。
 *
 * 出力は WP投稿フォーマット（§5-3）に整形:
 *   - タイトル: 【AI提案/リライト】元タイトル / 【AI提案/新規】タイトル案
 *   - 本文冒頭に提案理由コメントブロックを挿入
 *     <!-- SEOルーチン提案 | 実行日: YYYY-MM-DD | タイプ: リライト(R1) | 対象クエリ: ... | 現状: ... -->
 *
 * TODO(step6): @anthropic-ai/sdk で実装。CONFIG.anthropic.model を使用。
 */
import type { Candidate } from "../analyze/types.ts";

export interface GeneratedDraft {
  title: string; // 【AI提案/...】プレフィックス付き
  contentHtml: string; // 提案理由コメントブロック込みの本文HTML
  changeSummary?: string; // リライト時の変更点サマリー
}

export async function generateDraft(_c: Candidate): Promise<GeneratedDraft> {
  throw new Error("not implemented (step6)");
}
