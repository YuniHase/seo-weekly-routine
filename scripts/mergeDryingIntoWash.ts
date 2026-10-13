/**
 * /recoverywear_dryingmachine を /howtowash-recoverywear に統合するための下書きを作る。
 *
 * 実測で両記事は見出し10本が重複しており、勝っているのは howtowash 側
 * （表示2,593 / クリック31）。dryingmachine は公開から半年クロールすらされていない。
 * 食い合いを解消するため、事後対処の中身を howtowash に寄せてから301で畳む。
 *
 * 移すのは「乾燥機にかけた後どうするか」だけ。
 * 買い替え判断は /recoverywear_lifespan が勝っている領域なので持ち込まず、リンクで渡す。
 * 画像555とアフィリエイトコードは howtowash に既にあるため追加しない。
 *
 *   npx tsx scripts/mergeDryingIntoWash.ts         # 生成して検証のみ
 *   npx tsx scripts/mergeDryingIntoWash.ts --post  # 新規下書きとして投稿
 *
 * 元記事(201/468)は読むだけで変更しない。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchPostContent, createDraft } from "../src/fetch/wp.ts";

const POST = process.argv.includes("--post");
const TARGET = 201; // howtowash-recoverywear
const ANCHOR = '<h2 class="wp-block-heading">柔軟剤は使ってもいい？'; // 対処法h2の次のh2

const OLD_LINK_P =
  '<p>乾燥機をうっかり使ってしまった時の見極め方や対処の考え方は、<a href="https://recovery-wear-guide.com/recoverywear_dryingmachine/">リカバリーウェアを乾燥機にかけてしまったら？縮み・機能・対処法を解説</a>でも詳しく解説しています。</p>';
const NEW_LINK_P =
  '<p>乾燥機のダメージが戻らず、買い替えを考えたくなったときは、<a href="https://recovery-wear-guide.com/recoverywear_lifespan/">リカバリーウェアの効果はいつまで？寿命の目安「1〜2年」と買い替えサイン</a>で判断の目安を解説しています。</p>';

const INSERT = `<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">「縮みを戻せないか」と考える前に知っておきたいこと</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>乾燥機にかけてしまったあと、「なんとか元に戻せないか」と考える方も多いと思います。結論として、<strong><span class="marker-under-blue">縮んでしまった生地を、元通りの状態に戻す方法があるとは言い切れません</span></strong>。水に浸す、引っ張って伸ばすといった方法を試したくなる気持ちは分かりますが、生地によってはさらに傷みが進んだり、繊維にダメージが出たりすることもあります。</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>縮みを戻そうと試行錯誤するよりも、<strong><span class="marker-under-blue">現状を正しく把握し、今後の洗濯方法に活かす</span></strong>方が現実的な対応と言えるでしょう。洗濯表示タグの「タンブル乾燥禁止」の記号は、ここで改めて確認しておきたいポイントです。</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">まずは無理に戻そうとしない</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>「縮んだかも」と思っても、<strong><span class="marker-under-blue">強く引っ張ったり、無理に伸ばしたりするのはおすすめできません</span></strong>。<br>生地に余計な負担がかかって、別のダメージが出ることもあります。</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>まずは落ち着いて、今の状態を確認することが先です。<br>焦って対処しようとするより、見た目と着心地をチェックして、まだ使えるかどうかを見極める方が現実的です。</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">形を整えて自然な状態で確認する</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>洗濯直後や乾燥直後は、<strong><span class="marker-under-blue">形が不安定に見えることもあります</span></strong>。<br>そのため、いったん平らな場所に置く、ハンガーに掛けて全体の形を見るなどして、落ち着いた状態で確認すると判断しやすいです。</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>丈感やシルエットが気になる場合も、焦って結論を出すのではなく、自然な状態で比べてみると違いが見えやすくなります。</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">実際に着てから判断する</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>リカバリーウェアは、<strong><span class="marker-under-blue">見た目だけでなく着た感覚がかなり大事</span></strong>です。<br>「縮んだ気がする」「少し違うかも」と思っても、実際にはそこまで問題なく着られることもあります。</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph -->
<p>逆に、見た目には分からなくても、着た瞬間にごわつきや窮屈さが気になる場合もあります。<br>最終的には、快適に着続けられるかどうかで判断するのが一番分かりやすいです。</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":3} -->
<h3 class="wp-block-heading">伸びや縮みは「生地の種類」によっても出方が違う</h3>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>同じように乾燥機にかけても、縮みが目立ちやすい生地もあれば、型崩れやヨレとして現れる生地もあります。どちらが出るかは一概には言えませんが、いずれにしても「熱と摩擦が繰り返しかかることで生地の状態が変わりやすい」という点は共通しています。気になる場合は、無理に自己判断で加工するのではなく、現状維持を意識しながら今後の洗濯方法を見直すのが安心です。</p>
<!-- /wp:paragraph -->

`;

const orig = await fetchPostContent(TARGET);
let html = orig.contentHtml;

if (!html.includes(ANCHOR)) throw new Error("挿入位置の見出しが見つかりません（記事が変わった可能性）");
if (!html.includes(OLD_LINK_P)) throw new Error("差し替え対象のリンク段落が見つかりません（記事が変わった可能性）");

const removed = OLD_LINK_P;
html = html.replace(OLD_LINK_P, NEW_LINK_P);
html = html.replace(ANCHOR, INSERT + ANCHOR);

// 検証: 差し替えた1段落以外、元記事が1文字も欠けていないこと
const origMinus = orig.contentHtml.replace(removed, "");
const newMinus = html.replace(NEW_LINK_P, "").replace(INSERT, "");
const preserved = origMinus === newMinus;

const strip = (h: string) => h.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
console.log(`元記事の保持: ${preserved ? "✅ 差し替えた1段落以外すべて保持" : "❌ 差分あり"}`);
console.log(`本文: ${strip(orig.contentHtml)}字 → ${strip(html)}字`);
console.log(`見出し: h2 ${(html.match(/<h2/g) ?? []).length}本 / h3 ${(html.match(/<h3/g) ?? []).length}本`);
console.log(`ショートコード: ${JSON.stringify(html.match(/\[affi[^\]]*\]/g) ?? [])}（追加なし）`);
console.log(`価格金額: ${JSON.stringify(html.match(/[0-9０-９,，]+\s*円|[0-9０-９.]+\s*万円/g) ?? [])}`);
console.log(`断定的効能表現: ${JSON.stringify(html.match(/治る|治療|必ず痩せ|効きます|改善します|完治/g) ?? [])}`);
console.log(`dryingmachineへのリンク: ${(html.match(/recoverywear_dryingmachine/g) ?? []).length}件（0なら統合後に残らない）`);
console.log(`lifespanへのリンク: ${(html.match(/recoverywear_lifespan/g) ?? []).length}件`);

if (!preserved) process.exit(1);
writeFileSync("merge-201.html", html);
console.log("\nmerge-201.html に保存しました。");

if (!POST) {
  console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。");
  process.exit(0);
}
const created = await createDraft({ title: `【AI提案/統合】${orig.title}`, contentHtml: html });
console.log(`\n新規下書きとして投稿しました: id=${created.id}`);
console.log(created.editLink ?? "");
