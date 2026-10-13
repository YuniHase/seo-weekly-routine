/**
 * 記事同士の内容の重なりを測り、統合候補（カニバリゼーション）を洗い出す。
 *
 * インデックスされない原因の多くは技術的な問題ではなく「似た記事が複数ある」こと。
 * Googleは似たページ群から1本だけ選び、残りを捨てる。捨てられた側に張られた
 * 内部リンクの評価も死ぬため、本数を増やすほど損をする状態になる。
 *
 * 類似度は見出し（h2/h3）＋タイトルの文字バイグラムDice係数で測る。
 * 形態素解析器を使わずに日本語の近さを拾うための近似。
 *
 *   npx tsx scripts/findDuplicates.ts            # 類似0.25以上のペアを表示
 *   npx tsx scripts/findDuplicates.ts --min 0.3  # しきい値を変える
 *
 * 元記事は読むだけで変更しない。
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { fetchWpSnapshot, fetchPostContent, fetchAffiliateShortcodes, lastInternalLinks } from "../src/fetch/wp.ts";
import { bigrams, dice, inboundCounts } from "../src/analyze/internalLinks.ts";
import { log } from "../src/util/logger.ts";

const mIdx = process.argv.indexOf("--min");
const MIN = mIdx >= 0 ? Number(process.argv[mIdx + 1]) : 0.25;

const wp = await fetchWpSnapshot();
await fetchAffiliateShortcodes(wp); // lastInternalLinks を埋める副作用
const inbound = inboundCounts(lastInternalLinks);

// インデックス状況（事前に scripts/indexStatus.ts を実行しておくと注釈が付く）
const idx = new Map<number, { verdict: string; coverage: string; impressions: number; clicks: number }>();
if (existsSync("data/indexStatus.json")) {
  for (const r of JSON.parse(readFileSync("data/indexStatus.json", "utf8")).rows) idx.set(r.id, r);
}

interface Doc { id: number; path: string; title: string; headings: string[]; chars: number; sig: Set<string> }

const docs: Doc[] = [];
for (const p of wp.publish) {
  const c = await fetchPostContent(p.id);
  const headings = [...c.contentHtml.matchAll(/<h[23][^>]*>(.*?)<\/h[23]>/gs)].map((m) =>
    m[1].replace(/<[^>]*>/g, "").trim(),
  );
  const path = new URL(p.link).pathname.replace(/\/+$/, "");
  docs.push({
    id: p.id,
    path,
    title: p.title,
    headings,
    chars: c.contentHtml.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length,
    sig: bigrams([p.title, ...headings].join(" ")),
  });
  process.stderr.write(".");
}
process.stderr.write("\n");

const pairs: { a: Doc; b: Doc; score: number }[] = [];
for (let i = 0; i < docs.length; i++)
  for (let j = i + 1; j < docs.length; j++) {
    const s = dice(docs[i].sig, docs[j].sig);
    if (s >= MIN) pairs.push({ a: docs[i], b: docs[j], score: s });
  }
pairs.sort((x, y) => y.score - x.score);

const label = (d: Doc) => {
  const r = idx.get(d.id);
  if (!r) return "状況不明";
  const ok = r.verdict === "PASS";
  return `${ok ? "✅登録" : "⛔未登録"} 表示${r.impressions} クリック${r.clicks} 被リンク${inbound.get(d.path) ?? 0} ${d.chars}字`;
};

console.log(`\n類似度 ${MIN} 以上のペア: ${pairs.length}件\n`);
for (const { a, b, score } of pairs) {
  // 共通見出し（何が重複しているかの実体）
  const common = a.headings.filter((h) => b.headings.some((g) => dice(bigrams(h), bigrams(g)) >= 0.5));
  console.log(`類似 ${score.toFixed(3)}`);
  console.log(`  A ${a.path.padEnd(28)} ${label(a)}`);
  console.log(`    ${a.title.slice(0, 50)}`);
  console.log(`  B ${b.path.padEnd(28)} ${label(b)}`);
  console.log(`    ${b.title.slice(0, 50)}`);
  if (common.length) console.log(`  共通見出し(${common.length}): ${common.slice(0, 5).map((h) => h.slice(0, 26)).join(" / ")}`);
  console.log("");
}

// 記事ごとに「いくつの記事と被っているか」＝クラスタの中心を見る
const deg = new Map<string, number>();
for (const { a, b } of pairs) {
  deg.set(a.path, (deg.get(a.path) ?? 0) + 1);
  deg.set(b.path, (deg.get(b.path) ?? 0) + 1);
}
console.log("── 被り件数の多い記事（統合の軸になる）");
for (const [p, n] of [...deg.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12)) {
  const d = docs.find((x) => x.path === p)!;
  console.log(`  ${String(n).padStart(2)}本と被り  ${p.padEnd(28)} ${label(d)}`);
}
