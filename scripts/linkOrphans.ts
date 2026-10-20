/**
 * 孤立記事（被リンク0）へのリンクを、リライトと切り離して単独で張る。
 *
 * これまで孤立記事へのリンクは、リライト下書きを生成するときの副産物としてしか
 * 入らなかった。そのためクールダウンで下書きが0件になる週は、内部リンクの改善も
 * 同時に止まっていた（実測: 40本中17本が被リンク0）。
 *
 * リンクを張る相手は選ぶ。Googleが「クロール済み・インデックス未登録」と判定した
 * 記事は、見た上で見送られている。そこへリンクを足しても判定は変わらないため、
 * 稼いでいる記事の評価を流す先としては優先度が低い。
 * 逆に「一度もクロールされていない」記事は、発見経路が無いことが原因なので
 * 毎日クロールされている記事からの1本が効く。
 *
 *   npx tsx scripts/linkOrphans.ts               # 何をどこから張るかの計画だけ表示
 *   npx tsx scripts/linkOrphans.ts --run 74      # リンク元ID 74 の追記を生成（投稿しない）
 *   npx tsx scripts/linkOrphans.ts --run 74 --post
 *
 * 元記事は読むだけで変更しない。生成物は必ず別の新規下書きとして投稿する。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import {
  fetchWpSnapshot,
  fetchPostContent,
  fetchAffiliateShortcodes,
  lastInternalLinks,
  createDraft,
} from "../src/fetch/wp.ts";
import { findOrphans, inboundCounts } from "../src/analyze/internalLinks.ts";
import { bigrams, dice } from "../src/analyze/internalLinks.ts";
import { fetchGscData } from "../src/fetch/gsc.ts";
import { aggregateByUrl } from "../src/analyze/aggregate.ts";
import { normalizeUrl } from "../src/util/urlNormalize.ts";
import { getGoogleAuth } from "../src/fetch/googleAuth.ts";
import { COMPLIANCE_GUIDE } from "../src/generate/prompts.ts";
import { CONFIG } from "../src/config.ts";
import { log } from "../src/util/logger.ts";

const args = process.argv.slice(2);
const POST = args.includes("--post");
const runIdx = args.indexOf("--run");
const RUN_ID = runIdx >= 0 ? Number(args[runIdx + 1]) : null;

/** リンクが効く見込みの順。クロール済みで見送られた記事は最下位 */
const PRIORITY: Record<string, { rank: number; label: string }> = {
  "URL is unknown to Google": { rank: 0, label: "❗Google未認識（発見経路がない）" },
  "Discovered - currently not indexed": { rank: 1, label: "⚠️ 検出のみ・未クロール" },
  "Submitted and indexed": { rank: 2, label: "✅ 登録済み（評価を足す）" },
  Indexed: { rank: 2, label: "✅ 登録済み（評価を足す）" },
  "Indexed, not submitted in sitemap": { rank: 2, label: "✅ 登録済み" },
  "Crawled - currently not indexed": { rank: 9, label: "⛔ クロール済み・見送られた（リンクでは変わらない）" },
};
const priorityOf = (cov: string) => PRIORITY[cov] ?? { rank: 5, label: cov };

const sc = google.searchconsole({ version: "v1", auth: getGoogleAuth() });
async function coverage(url: string): Promise<string> {
  try {
    const res = await sc.urlInspection.index.inspect({
      requestBody: { inspectionUrl: url, siteUrl: CONFIG.google.gscSiteUrl, languageCode: "en" },
    });
    return res.data.inspectionResult?.indexStatusResult?.coverageState ?? "-";
  } catch {
    return "照会失敗";
  }
}

const wp = await fetchWpSnapshot();
await fetchAffiliateShortcodes(wp); // lastInternalLinks を埋める副作用
const nodes = lastInternalLinks;
const inbound = inboundCounts(nodes);
const orphans = findOrphans(nodes);

// リンク元は「Googleが実際に見に来ている記事」でなければ発見経路にならない
const gsc = await fetchGscData();
const agg = aggregateByUrl(gsc.current, gsc.currentPages);
const impressionsOf = (path: string) => agg.get(normalizeUrl(CONFIG.wp.baseUrl + path + "/"))?.impressions ?? 0;

log.info("孤立記事のインデックス状況を照会します", { 孤立: orphans.length, 全体: nodes.length });

interface Plan {
  orphan: { path: string; title: string; cov: string; rank: number; label: string };
  source: { id: number; path: string; title: string; impressions: number; score: number } | null;
}

const plans: Plan[] = [];
for (const o of orphans) {
  const cov = await coverage(CONFIG.wp.baseUrl + o.path + "/");
  const { rank, label } = priorityOf(cov);
  const ob = bigrams(o.title);
  // リンク元候補: 表示実績がある＝クロールされている記事のうち、まだこの記事に張っていないもの
  const best = nodes
    .filter((n) => n.path !== o.path && !n.outbound.includes(o.path) && impressionsOf(n.path) > 0)
    .map((n) => {
      const ref = wp.publish.find((p) => new URL(p.link).pathname.replace(/\/+$/, "") === n.path);
      return { id: ref?.id ?? 0, path: n.path, title: n.title, impressions: impressionsOf(n.path), score: dice(ob, bigrams(n.title)) };
    })
    .sort((a, b) => b.score - a.score)[0];
  plans.push({ orphan: { path: o.path, title: o.title, cov, rank, label }, source: best && best.score >= 0.1 ? best : null });
  process.stderr.write(".");
  await new Promise((r) => setTimeout(r, 250)); // 600req/分の上限に余裕を持たせる
}
process.stderr.write("\n");
plans.sort((a, b) => a.orphan.rank - b.orphan.rank || (b.source?.score ?? 0) - (a.source?.score ?? 0));

if (RUN_ID === null) {
  console.log(`\n孤立記事 ${orphans.length}本 / 全${nodes.length}本\n`);
  let lastLabel = "";
  for (const p of plans) {
    if (p.orphan.label !== lastLabel) {
      console.log(`\n── ${p.orphan.label} ${"─".repeat(Math.max(0, 50 - p.orphan.label.length))}`);
      lastLabel = p.orphan.label;
    }
    console.log(`  ${p.orphan.path}`);
    console.log(`    ${p.orphan.title.slice(0, 44)}`);
    if (p.source) console.log(`    ← リンク元候補: ${p.source.path}（表示${p.source.impressions} / 関連度${p.source.score.toFixed(2)} / id=${p.source.id}）`);
    else console.log(`    ← 関連の強いリンク元が見つかりません（無理に張らない）`);
  }
  // リンク元ごとにまとめると、1記事への追記で複数の孤立記事を拾える
  const bySource = new Map<number, Plan[]>();
  for (const p of plans) {
    if (!p.source || p.orphan.rank >= 9) continue; // 見送られた記事は対象外
    bySource.set(p.source.id, [...(bySource.get(p.source.id) ?? []), p]);
  }
  console.log(`\n\n── 実行単位（リンク元ごと・1記事につき下書き1本）`);
  for (const [id, ps] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  npx tsx scripts/linkOrphans.ts --run ${id}   … ${ps[0].source!.path} から ${ps.length}本`);
    for (const p of ps) console.log(`      → ${p.orphan.path}`);
  }
  process.exit(0);
}

// ---- 生成 ----
const targets = plans.filter((p) => p.source?.id === RUN_ID && p.orphan.rank < 9);
if (!targets.length) throw new Error(`id=${RUN_ID} をリンク元とする対象がありません（計画を先に確認してください）`);
const ref = wp.publish.find((p) => p.id === RUN_ID);
if (!ref) throw new Error(`公開記事に id=${RUN_ID} が見つかりません`);
const orig = await fetchPostContent(RUN_ID);

const h2s = [...orig.contentHtml.matchAll(/<h2[^>]*>(.*?)<\/h2>/gs)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());
const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });

const prompt = `あなたは日本語のSEO編集者です。既存記事に「関連記事への内部リンクを含む短い段落」だけを書き足します。

# リンク元の記事
タイトル: ${orig.title}
見出し一覧:
${h2s.map((h, i) => `${i + 1}. ${h}`).join("\n")}

# 張るリンク（この${targets.length}本すべてを使う）
${targets.map((t) => `- URL: ${CONFIG.wp.baseUrl}${t.orphan.path}/\n  タイトル: ${t.orphan.title}`).join("\n")}

# 指示
- リンクごとに「1段落（2〜3文）」を書く。段落の中で自然にリンクを張る。
- どの見出しの直前に置くべきかを、見出し一覧の番号で指定する。文脈が繋がる位置を選ぶ。
- 「こちらもどうぞ」のような空の誘導文にしない。リンク先を読むと何が分かるのかを書く。
- 事実・数値・商品スペックを新しく作らない。リンク先のタイトルから分かること以上を書かない。
- 価格や金額は書かない。
${COMPLIANCE_GUIDE}

# 出力形式（この形式を厳守。前後に説明を書かない）
===LINK===
BEFORE_H2: <見出し番号>
<p>…リンクを含む段落のHTML…</p>
===LINK===
BEFORE_H2: <見出し番号>
<p>…</p>
===END===`;

const msg = await client.messages.create({
  model: CONFIG.anthropic.model,
  max_tokens: 4000,
  thinking: { type: "disabled" },
  messages: [{ role: "user", content: prompt }],
});
const raw = msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");

const blocks = raw.split("===LINK===").slice(1).map((b) => b.split("===END===")[0]);
let html = orig.contentHtml;
const inserted: string[] = [];
for (const b of blocks) {
  const num = Number(b.match(/BEFORE_H2:\s*(\d+)/)?.[1]);
  const body = b.replace(/BEFORE_H2:\s*\d+/, "").trim();
  if (!num || !body || !h2s[num - 1]) continue;
  const anchor = [...html.matchAll(/<h2[^>]*>.*?<\/h2>/gs)].find((m) => m[0].replace(/<[^>]*>/g, "").trim() === h2s[num - 1]);
  if (!anchor) continue;
  html = html.replace(anchor[0], `${body}\n\n${anchor[0]}`);
  inserted.push(`${h2s[num - 1].slice(0, 26)} の前`);
}

const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
// 元記事が1文字も欠けていないこと（挿入のみで、既存の書き換えが起きていない）
const preserved = orig.contentHtml.split(/<h2/).every((seg) => html.includes(seg.slice(0, 120)));
console.log(`\n挿入: ${inserted.length}/${targets.length}本`);
for (const i of inserted) console.log(`  ・${i}`);
console.log(`元記事の保持: ${preserved ? "✅ 完全に保持" : "❌ 差分あり"}`);
console.log(`本文: ${strip(orig.contentHtml)}字 → ${strip(html)}字`);
console.log(`追加リンク: ${targets.map((t) => t.orphan.path).join(", ")}`);
console.log(`価格金額: ${JSON.stringify(html.match(/[0-9０-９,，]+\s*円|[0-9０-９.]+\s*万円/g) ?? [])}`);
console.log(`断定的効能表現: ${JSON.stringify(html.match(/治る|治療|必ず痩せ|効きます|改善します|完治/g) ?? [])}`);
console.log(`ショートコード: ${JSON.stringify(html.match(/\[affi[^\]]*\]/g) ?? [])}（追加なし）`);

if (!preserved || inserted.length === 0) process.exit(1);
writeFileSync(`orphanlinks-${RUN_ID}.html`, html);
console.log(`\norphanlinks-${RUN_ID}.html に保存しました。`);
if (!POST) { console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。"); process.exit(0); }
const created = await createDraft({ title: `【AI提案/内部リンク】${orig.title}`, contentHtml: html });
console.log(`\n新規下書きとして投稿しました: id=${created.id}`);
console.log(created.editLink ?? "");
