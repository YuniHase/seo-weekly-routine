/**
 * 既存の下書きのFAQを Cocoon の FAQブロックに変換する（後追い適用）。
 *
 * FAQブロック変換が入る前に生成された下書きに対して使う。
 * 通常の生成では assembleDraft が自動で変換するので、この経路は不要。
 *
 *   npx tsx scripts/applyFaqBlocks.ts 534 535          # 変換内容を表示のみ
 *   npx tsx scripts/applyFaqBlocks.ts 534 535 --write  # 実際に更新
 *
 * 安全のため status=draft の記事しか更新しない（公開済み・ゴミ箱は対象外）。
 * FAQ以外は書き換えないので、人間が編集済みの下書きにも適用できる。
 */
import "dotenv/config";
import { fetchWpSnapshot, fetchPostContent } from "../src/fetch/wp.ts";
import { toCocoonFaqBlocks } from "../src/generate/cocoonFaq.ts";
import { CONFIG } from "../src/config.ts";

const WRITE = process.argv.includes("--write");
const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
if (ids.length === 0) throw new Error("対象の記事IDを指定してください");

const wp = await fetchWpSnapshot();
const all = [...wp.publish, ...wp.draft, ...wp.trash];
const text = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, "");
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length;

for (const id of ids) {
  const ref = all.find((x) => x.id === id);
  if (!ref) { console.log(`[${id}] 見つかりません`); continue; }
  if (ref.status !== "draft") { console.log(`[${id}] status=${ref.status} のためスキップ（下書きのみ対象）`); continue; }

  const before = (await fetchPostContent(id)).contentHtml;
  const { html: after, converted } = toCocoonFaqBlocks(before);
  console.log(`\n[${id}] ${ref.title.slice(0, 44)}`);
  if (!converted) { console.log("  変換対象なし"); continue; }

  console.log(`  FAQブロック: ${count(before, /<!-- wp:cocoon-blocks\/faq/g)} → ${count(after, /<!-- wp:cocoon-blocks\/faq/g)}（変換${converted}件）`);
  console.log(`  可読テキスト長: ${text(before).length} → ${text(after).length}`);
  console.log(`  リンク: ${count(before, /<a\s+href=/g)} → ${count(after, /<a\s+href=/g)}`);
  console.log(`  ショートコード: ${JSON.stringify(before.match(/\[affi[^\]]*\]/g) ?? [])} → ${JSON.stringify(after.match(/\[affi[^\]]*\]/g) ?? [])}`);

  if (!WRITE) { console.log("  ※ --write を付けると更新します"); continue; }
  const auth = "Basic " + Buffer.from(`${CONFIG.wp.username}:${CONFIG.wp.appPassword}`).toString("base64");
  const res = await fetch(`${CONFIG.wp.baseUrl}/wp-json/wp/v2/posts/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ content: after }),
  });
  const v = await fetchPostContent(id);
  console.log(`  更新: ${res.status} / 確認: FAQブロック${count(v.contentHtml, /<!-- wp:cocoon-blocks\/faq/g)}件・残った<h3>Q ${count(v.contentHtml, /<h3[^>]*>\s*Q/gi)}件`);
}
