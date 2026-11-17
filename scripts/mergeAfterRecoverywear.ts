/**
 * /after-recoverywear(420) を /after-recoverywear-2(424) に統合するための下書きを作る。
 *
 * 2本はタイトル前半が同じで、検索意図も同じ（類似0.249・共通見出し4）。残すのは Google に
 * 登録済みの424。420 は公開から一度もクロールされていない。
 *
 * 424 に持ち込むのは420にしか無い2つだけ:
 *   - 【検証条件】のリスト（著者が実際に着た条件。経験の裏付けになる）
 *     ただし「価格は約25,000円」は落とす（景表法。420 は本文で約25,000円と1万数千円が食い違ってもいる）
 *   - FAQ「暑がりでも使いやすいリカバリーアイテムはありますか？」と [affi id=2]（靴下）
 *     424 にはアフィタグが1本も無く、週次レポートで「導線なし」と出ていた。
 *     424 の FAQ「夏場に…暑くて眠れません」は着方の話で、こちらは代わりのアイテムの話なので重複しない。
 *
 *   npx tsx scripts/mergeAfterRecoverywear.ts         # 生成して検証のみ
 *   npx tsx scripts/mergeAfterRecoverywear.ts --post  # 新規下書きとして投稿
 *
 * 反映後に人間がやること: 420 → 424 の301を張る。/recoverywear-winter の420へのリンクは
 * クールダウン明け（2026-12-13頃）に scripts/repointLink.ts で424へ向け直す。
 *
 * 元記事(420/424)は読むだけで変更しない。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchPostContent, createDraft } from "../src/fetch/wp.ts";

const POST = process.argv.includes("--post");
const SOURCE = 420; // after-recoverywear
const TARGET = 424; // after-recoverywear-2

const src = await fetchPostContent(SOURCE);
const dst = await fetchPostContent(TARGET);

/** 420 から、開始文字列〜終了文字列のブロックをそのまま切り出す（1か所だけであること） */
function cut(html: string, start: string, end: string): string {
  const a = html.indexOf(start);
  if (a < 0) throw new Error(`420 に「${start.slice(0, 40)}」が見つかりません（記事が変わった可能性）`);
  if (html.indexOf(start, a + 1) >= 0) throw new Error(`420 に「${start.slice(0, 40)}」が複数あります`);
  const b = html.indexOf(end, a);
  if (b < 0) throw new Error(`420 のブロックの終わりが見つかりません: ${start.slice(0, 40)}`);
  return html.slice(a, b + end.length);
}

const LEAD = "<!-- wp:paragraph -->\n<p>本稿では、私が実際にウェアを使用し、その後に習慣を切り替えたプロセスを記録しています。</p>\n<!-- /wp:paragraph -->";
const PRICE = "<br>購入方法：自腹で購入（価格は約25,000円）";
const listBlock = cut(src.contentHtml, "<!-- wp:list -->\n<ul class=\"wp-block-list\"><!-- wp:list-item -->\n<li><strong>【検証条件】</strong>", "<!-- /wp:list -->");
if (!listBlock.includes(PRICE)) throw new Error("検証条件の価格表記が想定と違います（落とし忘れを防ぐため止めます）");
if (!src.contentHtml.includes(LEAD)) throw new Error("検証条件の前置きの段落が見つかりません");
const CONDITIONS = `${LEAD}\n\n${listBlock.replace(PRICE, "<br>購入方法：自腹で購入")}\n\n`;

const FAQ = cut(
  src.contentHtml,
  '<!-- wp:cocoon-blocks/faq {"question":"暑がりでも使いやすいリカバリーアイテムはありますか？"} -->',
  "<!-- /wp:cocoon-blocks/faq -->",
);

// 424 への差し込み位置
const BEFORE_TRANSITION = "<!-- wp:paragraph -->\n<p>それでは、ここから詳しく見ていきましょう。</p>\n<!-- /wp:paragraph -->";
const SUMMER_FAQ_START = '<!-- wp:cocoon-blocks/faq {"question":"夏場にリカバリーウェアを着ると暑くて眠れません。"} -->';
let html = dst.contentHtml;
for (const anchor of [BEFORE_TRANSITION, SUMMER_FAQ_START]) {
  const n = html.split(anchor).length - 1;
  if (n !== 1) throw new Error(`424 の差し込み位置が${n}か所あります: ${anchor.slice(0, 50)}`);
}
// 検証条件: 最初の節の締めの一文「それでは、ここから…」の手前（420 と同じく 結論 → 検証条件 の順）
html = html.replace(BEFORE_TRANSITION, CONDITIONS + BEFORE_TRANSITION);
// FAQ: 「夏場に…」の FAQ の直後
const summerAt = html.indexOf(SUMMER_FAQ_START);
const summerEnd = html.indexOf("<!-- /wp:cocoon-blocks/faq -->", summerAt) + "<!-- /wp:cocoon-blocks/faq -->".length;
html = html.slice(0, summerEnd) + "\n\n" + FAQ + html.slice(summerEnd);

// 検証: 差し込んだ2か所を除けば、424 と1文字も違わないこと
const preserved = html.replace(CONDITIONS, "").replace("\n\n" + FAQ, "") === dst.contentHtml;
const strip = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
const inserted = CONDITIONS + FAQ;
console.log(`424 の保持: ${preserved ? "✅ 差し込んだ2か所以外すべて保持" : "❌ 差分あり"}`);
console.log(`本文: ${strip(dst.contentHtml)}字 → ${strip(html)}字`);
console.log(`見出し: h2 ${(html.match(/<h2/g) ?? []).length}本（元 ${(dst.contentHtml.match(/<h2/g) ?? []).length}本）`);
console.log(`FAQ: ${(dst.contentHtml.match(/wp:cocoon-blocks\/faq \{/g) ?? []).length} → ${(html.match(/wp:cocoon-blocks\/faq \{/g) ?? []).length}問`);
console.log(`ショートコード: ${JSON.stringify(dst.contentHtml.match(/\[affi[^\]]*\]/g) ?? [])} → ${JSON.stringify(html.match(/\[affi[^\]]*\]/g) ?? [])}`);
console.log(`価格金額（記事全体）: ${JSON.stringify(html.match(/[0-9０-９,，]+\s*円|[0-9０-９一二三四五六七八九十.]+\s*万[数0-9]*千?円|[数一二三四五六七八九十]+千円/g) ?? [])}`);
console.log(`断定的効能表現（差し込み部分）: ${JSON.stringify(inserted.match(/治る|治療|必ず痩せ|効きます|改善します|完治/g) ?? [])}`);
console.log(`420 へのリンク: ${(html.match(/after-recoverywear\/"/g) ?? []).length}件`);

if (!preserved) process.exit(1);
writeFileSync(`merge-${TARGET}.html`, html);
console.log(`\nmerge-${TARGET}.html に保存しました。`);

if (!POST) {
  console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。");
  process.exit(0);
}
const created = await createDraft({ title: `【AI提案/統合】${dst.title}`, contentHtml: html, proposal: { typeLabel: "統合", targetUrl: dst.link! } });
console.log(`\n新規下書きとして投稿しました: id=${created.id}`);
console.log(created.editLink ?? "");
