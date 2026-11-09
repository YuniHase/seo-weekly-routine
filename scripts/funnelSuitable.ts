/**
 * /recoverywear-suitable に、ブランド別レビュー・比較記事への導線を1か所足す下書きを作る。
 *
 * この記事は Google からの流入がサイトで一番多い（2026-10-10〜11-06 で GSC クリック78）のに、
 * アフィクリックは0だった。導線が無いわけではなく、3・4・8節目にレビュー・比較記事へのリンクと
 * [affi id=4] が既にある。測ると、着地した122セッションのうちレビュー・比較記事へ進んだのは6（5%）、
 * 最後まで読んだ（90%スクロール）のは約21%で、リンクのある中盤以降まで読者が届いていない。
 *
 * そこで、読者がまだ残っている前半に1か所だけ足す。位置は2節目「効果なしと感じやすい人の特徴」の直後。
 * 導入文が「デメリットが気になる方は、先に『効果なしと感じやすい人の特徴』の見出しから」と案内して
 * いるので、そこへ直接飛ぶ読者も、順に読む読者も通る。
 *
 * 文面はリンク先のタイトルから分かることだけで書く（事実・スペックを足さない）。
 * 既存の「▶リンク」段落の書き方に揃える。アフィタグは増やさない（効くかを導線だけで測るため）。
 *
 *   npx tsx scripts/funnelSuitable.ts         # 生成して検証のみ
 *   npx tsx scripts/funnelSuitable.ts --post  # 新規下書きとして投稿
 *
 * 公開は 2026-11-22 以降にする。meta description の変更（10/22）の再計測が11/22にあり、
 * それより前にこの記事を変えると再計測が濁る。
 *
 * 元記事(219)は読むだけで変更しない。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchPostContent, createDraft } from "../src/fetch/wp.ts";

const POST = process.argv.includes("--post");
const TARGET = 219; // recoverywear-suitable
const NEXT_H2 = '<h2 class="wp-block-heading">リカバリーウェアが「合う人」の特徴【実感しやすい人】</h2>';
const BASE = "https://recovery-wear-guide.com";

// レビューする人向けのメモ。本文の途中ではなく冒頭に置き、差し込む2段落だけを本番へ写せるようにする
const NOTE = `<!-- 導線の基準値（2026-10-10〜11-06）: この記事に着地した122セッションのうち、レビュー・比較記事へ進んだのは6（5%）、アフィクリック0。差し込んだのは2節目「効果なしと感じやすい人の特徴」直後の2段落だけ。公開は2026-11-22以降（meta descriptionの再計測と重ならないように） -->
`;

const INSERT = `<!-- wp:paragraph -->
<p>ここまでの特徴にあまり当てはまらなかった方は、このあとの「合う人」の特徴もあわせて確認してみてください。<strong><span class="marker-under-blue">気になっているブランドがすでにあるなら、ブランドごとの本音レビューを先に見ておくと選びやすくなります。</span></strong></p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>ブランド別に確認する↓<br>&#x25b6;<a href="${BASE}/bakune-review/">BAKUNE（バクネ）の正直レビュー｜合う人・やめた方がいい人</a><br>&#x25b6;<a href="${BASE}/venex-review/">VENEX（ベネクス）の口コミを検証｜1ヶ月着て分かった本音</a><br>&#x25b6;<a href="${BASE}/bakune-or-venex/">BAKUNEとVENEXで迷ったら｜違いとどっちがおすすめか</a></p>
<!-- /wp:paragraph -->

`;

const orig = await fetchPostContent(TARGET);
let html = orig.contentHtml;

// 次の h2 の直前にあるブロックコメント（<!-- wp:heading -->）ごと、その手前に差し込む
const h2At = html.indexOf(NEXT_H2);
if (h2At < 0) throw new Error("挿入位置の見出しが見つかりません（記事が変わった可能性）");
if (html.indexOf(NEXT_H2, h2At + 1) >= 0) throw new Error("挿入位置の見出しが複数あります");
const blockAt = html.lastIndexOf("<!-- wp:heading", h2At);
if (blockAt < 0 || h2At - blockAt > 40) throw new Error("見出しブロックの開始が見つかりません");
html = NOTE + html.slice(0, blockAt) + INSERT + html.slice(blockAt);

// 検証: 冒頭のメモと差し込んだ部分を除けば、元記事と1文字も違わないこと
const preserved = html.replace(NOTE, "").replace(INSERT, "") === orig.contentHtml;

const strip = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
const count = (h: string, path: string) => (h.match(new RegExp(`${BASE}${path}/?"`, "g")) ?? []).length;
console.log(`元記事の保持: ${preserved ? "✅ 差し込んだ部分以外すべて保持" : "❌ 差分あり"}`);
console.log(`本文: ${strip(orig.contentHtml)}字 → ${strip(html)}字`);
console.log(`見出し: h2 ${(html.match(/<h2/g) ?? []).length}本（変化なし: ${(orig.contentHtml.match(/<h2/g) ?? []).length}本）`);
for (const p of ["/bakune-review", "/venex-review", "/bakune-or-venex"]) {
  console.log(`${p} へのリンク: ${count(orig.contentHtml, p)} → ${count(html, p)}本`);
}
console.log(`差し込み位置: 全体の${Math.round((strip(orig.contentHtml.slice(0, blockAt)) / strip(html)) * 100)}%地点（2節目の直後）`);
console.log(`ショートコード: ${JSON.stringify(html.match(/\[affi[^\]]*\]/g) ?? [])}（追加なし）`);
console.log(`価格金額: ${JSON.stringify(html.match(/[0-9０-９,，]+\s*円|[0-9０-９.]+\s*万円/g) ?? [])}`);
console.log(`断定的効能表現: ${JSON.stringify(INSERT.match(/治る|治療|必ず痩せ|効きます|改善します|完治/g) ?? [])}（差し込み部分）`);

if (!preserved) process.exit(1);
writeFileSync(`funnel-${TARGET}.html`, html);
console.log(`\nfunnel-${TARGET}.html に保存しました。`);

if (!POST) {
  console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。");
  process.exit(0);
}
const created = await createDraft({ title: `【AI提案/導線】${orig.title}`, contentHtml: html, proposal: { typeLabel: "導線", targetUrl: orig.link! } });
console.log(`\n新規下書きとして投稿しました: id=${created.id}`);
console.log(created.editLink ?? "");
