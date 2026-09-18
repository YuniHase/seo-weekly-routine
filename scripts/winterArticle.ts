/**
 * 季節先行記事の手動生成（冬）。
 *
 * ルーチン（N1/N2）はGSCに露出があるクエリしか候補にできないため、まだ需要が
 * データに現れていない季節テーマは提案できない。季節プロファイルが「受け皿なし」
 * を警告したとき、人間が対象クエリを指定してこの経路で1本作る。
 *
 * 生成・投稿の型は週次ルーチンと共通（同じプロンプト・同じ検証・新規下書き投稿）。
 *   npx tsx scripts/winterArticle.ts            # 生成してレビュー表示のみ
 *   npx tsx scripts/winterArticle.ts --post     # 新規下書きとして投稿
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchWpSnapshot, fetchAffiliateShortcodes, createDraft } from "../src/fetch/wp.ts";
import { generateDraftSync } from "../src/generate/draft.ts";
import { log } from "../src/util/logger.ts";
import type { Candidate } from "../src/analyze/types.ts";

const POST = process.argv.includes("--post");

// 対象クエリ。GSCに露出が無い（＝データからは拾えない）ため人間が指定する。
// 「防寒着として足りるのか」が読者の不安点。夏記事が「暑くて着られないのでは」に
// 答えて伸びたのと同じ構造。
const QUERIES = [
  "リカバリーウェア 冬",
  "リカバリーウェア 冬用",
  "リカバリーウェア 寒い",
  "リカバリーウェア 冬 暖かい",
  "リカバリーウェア 裏起毛",
  "リカバリーウェア 重ね着",
];

const candidate: Candidate = {
  type: "new",
  rule: "N1",
  targetUrl: null,
  wpPostId: null,
  queries: QUERIES,
  score: 0,
  metrics: {},
  reason:
    `季節先行（冬）| 対象クエリはGSC未露出（過去180日で表示0）のため、季節プロファイルの` +
    `ピーク月11〜2月・リードタイム3ヶ月から逆算した先行投資。` +
    `夏クラスタ（表示6,035・クリック85・全体の33%）が10月に枯れるため、その置き換え。`,
};

const wp = await fetchWpSnapshot();
const affiliateCatalog = await fetchAffiliateShortcodes(wp);
const internalLinks = wp.publish.map((p) => ({ title: p.title, url: p.link }));

log.info("冬記事を生成します", { queries: QUERIES.length, catalog: affiliateCatalog.length, internalLinks: internalLinks.length });
const draft = await generateDraftSync(candidate, { internalLinks, affiliateCatalog });

// ── 検証 ──
const html = draft.contentHtml;
const valid = new Set(affiliateCatalog.map((s) => s.code));
const codes = html.match(/\[affi[^\]]*\]/g) ?? [];
const prices = html.match(/[0-9０-９,，]+\s*円|[0-9０-９.]+\s*万円/g) ?? [];
const ng = html.match(/治る|治療|必ず痩せ|効きます|改善します|完治/g) ?? [];
const placeholders = html.match(/【要確認[^】]*】/g) ?? [];
const links = html.match(/<a\s+href="[^"]+"/g) ?? [];
const external = links.filter((l) => !l.includes("recovery-wear-guide.com"));

console.log(`\nタイトル: ${draft.title}`);
console.log(`本文長: ${html.length} / outTokens: ${draft.usage.outputTokens}`);
console.log(`ショートコード: ${codes.length}件 ${JSON.stringify(codes)}`);
console.log(`カタログ外ID: ${JSON.stringify(codes.filter((c) => !valid.has(c)))}`);
console.log(`価格金額: ${prices.length}件 ${JSON.stringify(prices)}`);
console.log(`断定的効能表現: ${ng.length}件 ${JSON.stringify(ng)}`);
console.log(`【要確認】: ${placeholders.length}件 ${JSON.stringify(placeholders.slice(0, 8))}`);
console.log(`内部リンク: ${links.length - external.length}件 / サイト外リンク: ${external.length}件 ${JSON.stringify(external)}`);

writeFileSync("winter-draft.html", html);
console.log("\n本文を winter-draft.html に保存しました。");

if (!POST) {
  console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。");
  process.exit(0);
}

const created = await createDraft({ title: draft.title, contentHtml: html });
console.log(`\n新規下書きとして投稿しました: id=${created.id} status=${created.status}`);
console.log(created.editLink ?? "");
