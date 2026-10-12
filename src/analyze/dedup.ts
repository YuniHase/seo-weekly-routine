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
import type { Candidate, WpSnapshot, WpPostRef, ProposalTargets } from "./types.ts";

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

/**
 * ゴミ箱は「却下」ではなく「対応済み」を意味する運用になっている。
 * 反映した下書きをゴミ箱へ移すため、恒久的に除外すると候補が枯れてしまう
 * （実際に7件すべてがスキップされ、提案が0件になった）。
 *
 * そこでゴミ箱は**クールダウン**として扱い、前回提案から一定期間が過ぎたら再び候補に戻す。
 * CTR改善は一度で終わる施策ではなく、繰り返す価値がある。
 * 一方、下書きとして残っているもの（＝未レビュー）は常に除外する。
 */
function daysSince(dateStr: string | undefined, now: Date): number | null {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 864e5);
}

export function filterAlreadyProposed(
  candidates: Candidate[],
  wp: WpSnapshot,
  proposalTargets?: ProposalTargets,
  /** URL→最終提案日（data/proposals.json 由来）。クールダウン判定に使う */
  lastProposedByUrl?: Map<string, string>,
  cooldownDays = 60,
  now: Date = new Date(),
): DedupResult {
  const draftUrls = new Set(wp.draft.map((p) => normalizeUrl(p.link)));
  const trashUrls = new Set(wp.trash.map((p) => normalizeUrl(p.link)));
  const allPosts = [...wp.publish, ...wp.draft, ...wp.trash];
  const publishByUrl = new Map(wp.publish.map((p) => [normalizeUrl(p.link), p] as const));
  // 我々が作る提案ドラフトは「新規記事」なので targetURLとはURLが一致しない。
  // よって「【AI提案/...】元タイトル」というタイトルマーカーで既提案/却下を検出する。
  const proposalPosts = [...wp.draft.map((p) => ({ p, st: "draft" as const })), ...wp.trash.map((p) => ({ p, st: "trash" as const }))]
    .filter(({ p }) => p.title.includes("AI提案"));

  const kept: Candidate[] = [];
  const skipped: Array<{ candidate: Candidate; reason: string }> = [];

  for (const c of candidates) {
    if (c.type === "rewrite" && c.targetUrl) {
      const u = normalizeUrl(c.targetUrl);
      // 最優先: 提案本文の `対象:URL` で照合（タイトル変更に強い・恒久的に堅牢）
      if (proposalTargets?.drafted.has(u)) { skipped.push({ candidate: c, reason: "draftに提案済み(対象URL一致)" }); continue; }
      if (proposalTargets?.rejected.has(u)) {
        const elapsed = daysSince(lastProposedByUrl?.get(u), now);
        if (elapsed === null || elapsed < cooldownDays) {
          const left = elapsed === null ? cooldownDays : cooldownDays - elapsed;
          skipped.push({ candidate: c, reason: `対応済み・クールダウン中(あと約${left}日)` });
          continue;
        }
        // 経過したので再提案を許可（理由は reason に残す）
        c.reason = `${c.reason} | 前回提案から${elapsed}日経過のため再提案`;
      }
      // フォールバック(URL一致): 提案自体のURLが対象と一致するケース
      if (draftUrls.has(u)) { skipped.push({ candidate: c, reason: "draftに提案済み(URL一致)" }); continue; }
      if (trashUrls.has(u)) { skipped.push({ candidate: c, reason: "trashで却下済み(URL一致)" }); continue; }
      // フォールバック(タイトルマーカー): 元記事タイトルを含むAI提案ドラフト/ゴミ箱
      const src = publishByUrl.get(u);
      if (src?.title) {
        const st = normText(src.title);
        const hit = proposalPosts.find(({ p }) => st && normText(p.title).includes(st));
        if (hit) {
          // 下書き（未レビュー）は常に除外。ゴミ箱＝対応済みはクールダウン扱い。
          if (hit.st === "draft") {
            skipped.push({ candidate: c, reason: "draftに提案済み(タイトル一致)" });
            continue;
          }
          const elapsed = daysSince(lastProposedByUrl?.get(u), now);
          if (elapsed === null || elapsed < cooldownDays) {
            const left = elapsed === null ? cooldownDays : cooldownDays - elapsed;
            skipped.push({ candidate: c, reason: `対応済み・クールダウン中(あと約${left}日・タイトル一致)` });
            continue;
          }
          c.reason = `${c.reason} | 前回提案から${elapsed}日経過のため再提案`;
        }
      }
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
