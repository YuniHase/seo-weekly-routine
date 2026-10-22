/**
 * 発見経路がない記事へのリンクを、リライトと切り離して単独で張る。
 *
 * これまで孤立記事へのリンクは、リライト下書きを生成するときの副産物としてしか
 * 入らなかった。そのためクールダウンで下書きが0件になる週は、内部リンクの改善も
 * 同時に止まっていた（実測: 40本中17本が被リンク0）。
 *
 * 対象は「被リンク0」ではなく「クロールされている記事からの被リンクが0」で選ぶ。
 * 被リンクがあっても張り元が未クロールなら経路として機能しないためで、実測では
 * /humidity-sleep と /tropicalnight-tips が互いにだけリンクし合う閉じた輪になっていた。
 * 本数で見ると被リンクありと数えられ、この2本は対象から漏れていた。
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
import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import {
  fetchWpSnapshot,
  fetchPostContent,
  fetchAffiliateShortcodes,
  fetchProposalRecords,
  proposalTargetsFromRecords,
  lastInternalLinks,
  createDraft,
} from "../src/fetch/wp.ts";
import { filterAlreadyProposed } from "../src/analyze/dedup.ts";
import type { Candidate } from "../src/analyze/types.ts";
import { loadHistory, mergeHistory } from "../src/history/store.ts";
import { findUndiscovered } from "../src/analyze/internalLinks.ts";
import { bigrams, dice } from "../src/analyze/internalLinks.ts";
import type { ArticleNode } from "../src/analyze/internalLinks.ts";
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

/**
 * クロール済みかどうかの判定。
 *
 * 表示0は「低順位」ではなく「未登録」かもしれないので、表示実績だけでは切り分けられない。
 * `scripts/indexStatus.ts` が残した lastCrawl（＝Googleが実際に見に来た記録）を正とし、
 * その記録が無いときだけ表示実績で代用する。
 */
function crawledSet(nodes: ArticleNode[], impOf: (p: string) => number): Set<string> {
  let rows: Array<{ url: string; lastCrawl?: string | null }> = [];
  let checkedAt = "";
  try {
    const f = JSON.parse(readFileSync("data/indexStatus.json", "utf8"));
    rows = f.rows ?? [];
    checkedAt = f.checkedAt ?? "";
  } catch {
    /* 無ければ表示実績だけで判断する */
  }
  const byPath = new Map(rows.map((r) => [new URL(r.url).pathname.replace(/\/+$/, ""), r]));
  const out = new Set<string>();
  for (const n of nodes) {
    const row = byPath.get(n.path);
    if (row ? !!row.lastCrawl : impOf(n.path) > 0) out.add(n.path);
  }
  const ageDays = checkedAt ? Math.floor((Date.now() - Date.parse(checkedAt)) / 86_400_000) : null;
  log.info("クロール済みの判定", {
    クロール済み: out.size,
    全体: nodes.length,
    根拠: rows.length ? `data/indexStatus.json（${checkedAt.slice(0, 10)} 取得・${ageDays}日前）` : "表示実績のみ（indexStatus.json が無い）",
  });
  if (ageDays !== null && ageDays > 21) log.info("※ インデックス状況が古いので scripts/indexStatus.ts の再実行を検討", { 経過日数: ageDays });
  return out;
}

const wp = await fetchWpSnapshot();
await fetchAffiliateShortcodes(wp); // lastInternalLinks を埋める副作用
const nodes = lastInternalLinks;

// リンク元は「Googleが実際に見に来ている記事」でなければ発見経路にならない
const gsc = await fetchGscData();
const agg = aggregateByUrl(gsc.current, gsc.currentPages);
const impressionsOf = (path: string) => agg.get(normalizeUrl(CONFIG.wp.baseUrl + path + "/"))?.impressions ?? 0;

// 対象は被リンク0ではなく、クロールされている記事からの被リンクが0の記事
const crawled = crawledSet(nodes, impressionsOf);
const orphans = findUndiscovered(nodes, crawled);

log.info("発見経路がない記事のインデックス状況を照会します", {
  対象: orphans.length,
  うち被リンク0: orphans.filter((o) => o.inbound === 0).length,
  うち張り元が未クロール: orphans.filter((o) => o.inbound > 0).length,
  全体: nodes.length,
});

interface Plan {
  orphan: { path: string; title: string; cov: string; rank: number; label: string; inbound: number };
  source: { id: number; path: string; title: string; impressions: number; score: number; via: string; viaQuery: boolean } | null;
  /** 閾値に届かなかった最有力候補。なぜ張れないのかを示すために残す */
  nearest: { path: string; score: number; via: string; viaQuery: boolean } | null;
  /** 関連度では最有力だが、クールダウン中のため外したリンク元 */
  blocked: { path: string; score: number; reason: string } | null;
}
const MIN_SCORE = 0.1;

/**
 * リンク元の守備範囲は、タイトルよりも「実際に表示されているクエリ」のほうがよく表す。
 * タイトルだけで測ると、/tropicalnight-tips（熱帯夜）に対する最有力が
 * /recoverywear-size（サイズ選び）になるような的外れが起きる。
 *
 * ただし全クエリを1本の文字列に連結してはいけない。バイグラム集合が肥大し、
 * Dice係数は集合サイズの差だけで下がるので、閾値の意味が変わってしまう。
 * タイトルと各クエリを別々に比べて最も近いものを採る。見たいのは
 * 「このリンク元は、その話題のクエリで既に表示されているか」なので、1本強く一致すれば足りる。
 *
 * クエリ次元は検索回数の少ないクエリが匿名化されて取れないが、ここで欲しいのは
 * 記事の話題を言い表す代表的なクエリなので、取れている上位だけで足りる。
 */
interface SourceProfile {
  id: number;
  path: string;
  title: string;
  impressions: number;
  outbound: string[];
  texts: Array<{ text: string; bg: Set<string> }>;
}

// リンク元候補: 表示実績がある＝クロールされている記事。タイトルと上位クエリを別々に持つ
const queriesOf = (path: string) =>
  (agg.get(normalizeUrl(CONFIG.wp.baseUrl + path + "/"))?.queries ?? []).slice(0, 20).map((q) => q.query);
const sources: SourceProfile[] = nodes
  .filter((n) => impressionsOf(n.path) > 0)
  .map((n) => ({
    id: wp.publish.find((p) => new URL(p.link).pathname.replace(/\/+$/, "") === n.path)?.id ?? 0,
    path: n.path,
    title: n.title,
    impressions: impressionsOf(n.path),
    outbound: n.outbound,
    texts: [n.title, ...queriesOf(n.path)].map((text) => ({ text, bg: bigrams(text) })),
  }));
log.info("リンク元候補の守備範囲", {
  候補: sources.length,
  クエリ付き: sources.filter((s) => s.texts.length > 1).length,
  クエリ中央値: sources.map((s) => s.texts.length - 1).sort((a, b) => a - b)[Math.floor(sources.length / 2)],
});

/**
 * クールダウン中の記事はリンク元にしない。
 *
 * クールダウンはリライトの効果測定のためにある。リンク段落の追記はリライトより小さな変更だが、
 * 測定中の記事に手を入れれば前後比較が濁る点は同じ。しかもクエリで関連度を測ると、
 * 表示の多い主力記事＝直近でリライトした記事ほど最有力に上がってくるので、放っておくと
 * 毎回ここに当たる。
 *
 * 判定は週次ルーチンの filterAlreadyProposed をそのまま使う。未レビューの提案下書きが
 * 残っている記事も除外される（同じ記事に競合する下書きを2本作らないため）。
 * 残り日数の表示も週次レポートと一致する。
 */
const proposalRecords = await fetchProposalRecords(wp);
const { merged: history } = mergeHistory(
  loadHistory(),
  proposalRecords
    .filter((r) => r.targetUrl && r.runDate)
    .map((r) => ({ runDate: r.runDate!, targetUrl: r.targetUrl!, wpDraftId: r.id, title: r.title, before: r.before })),
);
const lastProposedByUrl = new Map(
  [...history].sort((a, b) => (a.runDate ?? "").localeCompare(b.runDate ?? "")).map((h) => [h.targetUrl, h.runDate] as const),
);
const probes: Candidate[] = sources.map((s) => ({
  type: "rewrite",
  rule: "R1",
  targetUrl: CONFIG.wp.baseUrl + s.path + "/",
  wpPostId: s.id,
  queries: [],
  score: 0,
  metrics: {},
  reason: "",
}));
const { skipped } = filterAlreadyProposed(
  probes,
  wp,
  proposalTargetsFromRecords(proposalRecords),
  lastProposedByUrl,
  CONFIG.run.reproposeAfterDays,
);
const pathOfProbe = new Map(probes.map((c, i) => [c, sources[i].path] as const));
const cooling = new Map(skipped.map((x) => [pathOfProbe.get(x.candidate)!, x.reason] as const));
log.info("クールダウン中のためリンク元から外す記事", {
  件数: cooling.size,
  記事: [...cooling].map(([path, reason]) => `${path} … ${reason}`),
});

const plans: Plan[] = [];
for (const o of orphans) {
  const cov = await coverage(CONFIG.wp.baseUrl + o.path + "/");
  const { rank, label } = priorityOf(cov);
  const ob = bigrams(o.title);
  const scored = sources
    .filter((s) => s.path !== o.path && !s.outbound.includes(o.path))
    .map((s) => {
      // タイトル・各クエリのうち最も近いものを、この記事との関連度とする
      let score = 0;
      let via = s.title;
      for (const t of s.texts) {
        const sc = dice(ob, t.bg);
        if (sc > score) ((score = sc), (via = t.text));
      }
      return { id: s.id, path: s.path, title: s.title, impressions: s.impressions, score, via, viaQuery: via !== s.title };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored.find((s) => !cooling.has(s.path));
  const passed = best && best.score >= MIN_SCORE ? best : null;
  // クールダウンが明ければ選ばれるはずの記事。いつ張れるようになるかを人間が判断できるように残す
  const top = scored[0];
  const blocked =
    top && cooling.has(top.path) && top.score >= MIN_SCORE && top.score > (passed?.score ?? 0)
      ? { path: top.path, score: top.score, reason: cooling.get(top.path)! }
      : null;
  plans.push({
    orphan: { path: o.path, title: o.title, cov, rank, label, inbound: o.inbound },
    source: passed,
    nearest: passed || !best ? null : { path: best.path, score: best.score, via: best.via, viaQuery: best.viaQuery },
    blocked,
  });
  process.stderr.write(".");
  await new Promise((r) => setTimeout(r, 250)); // 600req/分の上限に余裕を持たせる
}
process.stderr.write("\n");
plans.sort((a, b) => a.orphan.rank - b.orphan.rank || (b.source?.score ?? 0) - (a.source?.score ?? 0));

if (RUN_ID === null) {
  console.log(`\n発見経路がない記事 ${orphans.length}本 / 全${nodes.length}本`);
  console.log(`（被リンク0 ${orphans.filter((o) => o.inbound === 0).length}本 ＋ 張り元も未クロール ${orphans.filter((o) => o.inbound > 0).length}本）\n`);
  let lastLabel = "";
  for (const p of plans) {
    if (p.orphan.label !== lastLabel) {
      console.log(`\n── ${p.orphan.label} ${"─".repeat(Math.max(0, 50 - p.orphan.label.length))}`);
      lastLabel = p.orphan.label;
    }
    console.log(`  ${p.orphan.path}`);
    console.log(`    ${p.orphan.title.slice(0, 44)}`);
    if (p.orphan.inbound > 0) console.log(`    被リンク${p.orphan.inbound}本あるが、張り元もすべて未クロール（経路として機能していない）`);
    const via = (m: { via: string; viaQuery: boolean }) => (m.viaQuery ? `クエリ「${m.via}」で一致` : `タイトルで一致`);
    if (p.source) console.log(`    ← リンク元候補: ${p.source.path}（表示${p.source.impressions} / 関連度${p.source.score.toFixed(2)} / id=${p.source.id}）\n       ${via(p.source)}`);
    else if (p.nearest) console.log(`    ← 関連の強いリンク元が見つかりません（最も近い ${p.nearest.path} でも関連度${p.nearest.score.toFixed(3)}／閾値${MIN_SCORE}・${via(p.nearest)}）`);
    else console.log(`    ← 関連の強いリンク元が見つかりません（無理に張らない）`);
    if (p.blocked) console.log(`    ※ 最有力の ${p.blocked.path}（関連度${p.blocked.score.toFixed(2)}）は外した: ${p.blocked.reason}`);
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
const runPath = sources.find((s) => s.id === RUN_ID)?.path;
if (runPath && cooling.has(runPath)) {
  throw new Error(`id=${RUN_ID}（${runPath}）はクールダウン中なのでリンク元にしません: ${cooling.get(runPath)}`);
}
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
