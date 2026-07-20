/**
 * プロンプトテンプレート（§5）。
 *
 * 共通要件（リライト/新規とも）:
 *  - 薬機法・景表法に抵触する断定的効能表現を禁止（「治る」「必ず痩せる」等）。
 *    「サポート」「期待できる」等の表現に留める。
 *  - 事実・数値・商品情報は捏造しない。新規記事では商品スペック・価格・比較データ等
 *    事実確認が必要な箇所は必ずプレースホルダー【要確認: ○○】にする。
 *  - AI検索での引用されやすさ: 結論先出し、見出し直下に要点、Q&A構造の活用。
 *
 * リライト（5-1）: 元記事の構成・トーンを尊重し全書き換えせず改善に徹する。
 *   R1はタイトル案を3つ本文冒頭にコメントで提示。出力=本文HTML + 変更点サマリー。
 * 新規（5-2）: タイトル + 本文HTML（見出し構造付き） + メタディスクリプション案。3000〜5000字。
 *
 * TODO(step6): テンプレート本文を実装。
 */
import type { Candidate } from "../analyze/types.ts";

/** 薬機法・景表法まわりの禁止表現ガイドを共通ブロックとして各プロンプトに差し込む */
export const COMPLIANCE_GUIDE = `【表現ルール（必ず遵守）】
- 医薬品的な効能効果の断定表現（「治る」「治療」「必ず痩せる」「効く」等）は禁止。
- 「サポートが期待できる」「〜と言われています」等の非断定的表現に留める。
- 事実・数値・商品スペック・価格・比較データは、入力に無いものを創作しない。
  事実確認が必要な箇所は必ず 【要確認: ○○】 のプレースホルダーにする。`;

export function buildRewritePrompt(_c: Candidate, _originalHtml: string): string {
  throw new Error("not implemented (step6)");
}

export function buildNewArticlePrompt(_c: Candidate, _internalLinkTitles: string[]): string {
  throw new Error("not implemented (step6)");
}
