/**
 * 重複・却下判定（外部DBの代替。WordPress自身の記事ステータスで判定）。
 *
 *  - リライト候補: 対象URL（正規化）が draft に存在→提案済みスキップ / trash に存在→却下済みスキップ
 *  - 新規記事候補: 提案テーマ（クエリ）が publish/draft/trash の記事タイトル・スラッグと
 *    一致/部分一致→スキップ（受け皿が既にある or 提案済み/却下済み）
 *
 * URL照合は必ず normalizeUrl() を通す。テキスト照合は正規化（小文字化・空白/記号除去）した
 * 上での一致・部分一致（過剰に凝らない）。曖昧なものは §5 の Claude 判断に委ねる。
 */
import { normalizeUrl } from "../util/urlNormalize.ts";
import type { Candidate, WpSnapshot, WpPostRef } from "./types.ts";

export interface DedupResult {
  kept: Candidate[];
  skipped: Array<{ candidate: Candidate; reason: string }>;
}

/** 照合用テキスト正規化: 小文字化し、空白・記号を除去 */
function normText(s: string): string {
  return s.toLowerCase().replace(/[\s　]+/g, "").replace(/[!-/:-@[-`{-~、。・「」（）]/g, "");
}

function textMatches(query: string, post: WpPostRef): boolean {
  const q = normText(query);
  if (!q) return false;
  const title = normText(post.title);
  const slug = normText(post.slug);
  // クエリが記事タイトルに含まれる / タイトルがクエリに含まれる / スラッグ一致・部分一致
  return (
    (!!title && (title.includes(q) || q.includes(title))) ||
    (!!slug && (slug.includes(q) || q.includes(slug)))
  );
}

export function filterAlreadyProposed(candidates: Candidate[], wp: WpSnapshot): DedupResult {
  const draftUrls = new Set(wp.draft.map((p) => normalizeUrl(p.link)));
  const trashUrls = new Set(wp.trash.map((p) => normalizeUrl(p.link)));
  const allPosts = [...wp.publish, ...wp.draft, ...wp.trash];

  const kept: Candidate[] = [];
  const skipped: Array<{ candidate: Candidate; reason: string }> = [];

  for (const c of candidates) {
    if (c.type === "rewrite" && c.targetUrl) {
      const u = normalizeUrl(c.targetUrl);
      if (draftUrls.has(u)) { skipped.push({ candidate: c, reason: "draftに提案済み" }); continue; }
      if (trashUrls.has(u)) { skipped.push({ candidate: c, reason: "trashで却下済み" }); continue; }
      kept.push(c);
    } else {
      // 新規: いずれかのクエリが既存記事(公開/下書き/ゴミ箱)のタイトル・スラッグと一致
      const hit = allPosts.find((p) => c.queries.some((q) => textMatches(q, p)));
      if (hit) {
        const label = hit.status === "trash" ? "trashで却下済み" : hit.status === "draft" ? "draftに提案済み" : "既存の公開記事と重複";
        skipped.push({ candidate: c, reason: `${label}（${hit.title || hit.slug}）` });
        continue;
      }
      kept.push(c);
    }
  }
  return { kept, skipped };
}
