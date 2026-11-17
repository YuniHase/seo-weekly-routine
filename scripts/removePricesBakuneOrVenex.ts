/**
 * /bakune-or-venex(69) の本文から価格金額を外す下書きを作る（景表法）。
 *
 * BAKUNE と VENEX の比較記事で、買う直前の読者が来る。2026-11-08 に Google に登録された。
 * 本文に「上下セットで約20,000〜30,000円」が2か所あり、CLAUDE.md の
 * 「記事本文に具体的な価格金額を書かない」に反していた。
 * 価格の2か所だけを「最新価格は公式サイトでご確認ください」に置き換え、ほかは変えない。
 *
 * この下書きは、商品ラインナップが今と合っているかを人間が確認・修正する作業場所も兼ねる
 * （記事の表示日付は 2026-04）。
 *
 *   npx tsx scripts/removePricesBakuneOrVenex.ts         # 生成して検証のみ
 *   npx tsx scripts/removePricesBakuneOrVenex.ts --post  # 新規下書きとして投稿
 *
 * 元記事(69)は読むだけで変更しない。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchPostContent, createDraft } from "../src/fetch/wp.ts";

const POST = process.argv.includes("--post");
const TARGET = 69; // bakune-or-venex

const REPLACE: Array<[string, string]> = [
  ["<p>価格帯はどちらも上下セットで約20,000〜30,000円前後。大きな差はありません。</p>", "<p>価格帯に大きな差はありません。最新価格は公式サイトでご確認ください。</p>"],
  ["<li>価格帯の目安：上下セットで20,000円〜30,000円</li>", "<li>価格：最新価格は公式サイトでご確認ください</li>"],
];

const orig = await fetchPostContent(TARGET);
let html = orig.contentHtml;
for (const [from, to] of REPLACE) {
  const n = html.split(from).length - 1;
  if (n !== 1) throw new Error(`置き換え対象が${n}か所あります（記事が変わった可能性）: ${from.slice(0, 40)}`);
  html = html.replace(from, to);
}

// 検証: 置き換えた2か所を元に戻すと、元記事と1文字も違わないこと
let back = html;
for (const [from, to] of REPLACE) back = back.replace(to, from);
const preserved = back === orig.contentHtml;

const PRICE = /[0-9０-９,，]+\s*円|[0-9０-９一二三四五六七八九十.]+\s*万[数0-9]*千?円|[数一二三四五六七八九十]+千円/g;
console.log(`元記事の保持: ${preserved ? "✅ 置き換えた2か所以外すべて保持" : "❌ 差分あり"}`);
console.log(`価格金額: ${JSON.stringify(orig.contentHtml.match(PRICE) ?? [])} → ${JSON.stringify(html.match(PRICE) ?? [])}`);
console.log(`ショートコード: ${JSON.stringify(html.match(/\[affi[^\]]*\]/g) ?? [])}（変更なし）`);

if (!preserved || (html.match(PRICE) ?? []).length) process.exit(1);
writeFileSync(`prices-${TARGET}.html`, html);
console.log(`\nprices-${TARGET}.html に保存しました。`);

if (!POST) {
  console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。");
  process.exit(0);
}
const created = await createDraft({ title: `【AI提案/価格表記の削除】${orig.title}`, contentHtml: html, proposal: { typeLabel: "価格表記の削除", targetUrl: orig.link! } });
console.log(`\n新規下書きとして投稿しました: id=${created.id}`);
console.log(created.editLink ?? "");
