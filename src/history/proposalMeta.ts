/**
 * 提案下書きの冒頭に入れるメタコメント（`SEOルーチン提案`）の生成と読み取り。
 *
 * 週次ルーチンはこのコメントの「対象」と「実行日」から提案履歴（data/proposals.json）を作り、
 * クールダウンと効果測定に使う。生成と読み取りの形式がずれると履歴が黙って欠けるので、
 * 両方をここに置く。
 *
 * 週次の外のスクリプト（追記・内部リンク・統合・リンク修正）の下書きには以前これが無く、
 * 履歴に残らなかった。WPのゴミ箱が約30日で消えると記事を触った記録ごと消え、
 * 測定期間中の記事が再提案されていた（実例: /bakune-review は 9/28 に追記を反映し、
 * 11/2 の週次でリライトが再提案された）。
 */

export interface ProposalMetrics {
  position?: number;
  ctr?: number; // 0..1
  impressions?: number;
}

export interface ProposalMeta {
  runDate: string; // YYYY-MM-DD
  /** 例: `リライト(R1)` / `新規(N1)` / `追記` / `内部リンク` / `統合` / `リンク修正` */
  typeLabel: string;
  queries?: string[];
  metrics?: ProposalMetrics;
  /** 手を入れる既存記事のURL。新規記事なら無し */
  targetUrl?: string | null;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildProposalComment(m: ProposalMeta): string {
  const x = m.metrics ?? {};
  const state = [
    x.position !== undefined ? `順位${x.position.toFixed(1)}` : null,
    x.ctr !== undefined ? `CTR${(x.ctr * 100).toFixed(1)}%` : null,
    x.impressions !== undefined ? `Imp${x.impressions}` : null,
  ].filter(Boolean).join(" ");
  const q = m.queries ?? [];
  const qStr = q.length ? `"${q[0]}"${q.length > 1 ? ` 他${q.length - 1}件` : ""}` : "-";
  const target = m.targetUrl ? ` | 対象: ${m.targetUrl}` : "";
  return `<!-- SEOルーチン提案 | 実行日: ${m.runDate} | タイプ: ${m.typeLabel} | 対象クエリ: ${qStr} | 現状: ${state || "-"}${target} -->`;
}

export const hasProposalComment = (html: string) => /<!--\s*SEOルーチン提案/.test(html);

/**
 * メタコメントを読む。数値はコメントの中だけから拾う。
 * 本文全体から拾うと、記事中の「順位3」のような文言を提案時の数値と取り違える。
 */
export function parseProposalComment(html: string): { targetUrl: string | null; runDate: string | null; before: ProposalMetrics } | null {
  const c = html.match(/<!--\s*SEOルーチン提案([\s\S]*?)-->/)?.[1];
  if (c === undefined) return null;
  const pos = c.match(/順位([\d.]+)/)?.[1];
  const ctr = c.match(/CTR([\d.]+)%/)?.[1];
  const imp = c.match(/Imp([\d,]+)/)?.[1];
  return {
    targetUrl: c.match(/対象:\s*(https?:\/\/[^\s|>]+)/)?.[1] ?? null,
    runDate: c.match(/実行日:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
    before: {
      position: pos ? Number(pos) : undefined,
      ctr: ctr ? Number(ctr) / 100 : undefined,
      impressions: imp ? Number(imp.replace(/,/g, "")) : undefined,
    },
  };
}
