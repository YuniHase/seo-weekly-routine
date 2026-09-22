/**
 * 既存記事の手動リライト（ルーチンの候補に上がらない記事向け）。
 *
 * スコアは表示回数に比例するため、検索表示が0の記事は自動では絶対に選ばれない。
 * しかし「購入直前の記事なのにアフィリンクが0本」のように、流入と無関係に
 * 直す価値がある記事は存在する。週次レポートの🔌収益導線の監査で見つけたものを
 * この経路で処理する。
 *
 *   npx tsx scripts/rewriteArticle.ts 428              # 生成してレビュー表示のみ
 *   npx tsx scripts/rewriteArticle.ts 428 --post      # 生成してそのまま新規下書き投稿
 *   npx tsx scripts/rewriteArticle.ts 428 --post-saved # 直前に生成した内容をそのまま投稿
 *   npx tsx scripts/rewriteArticle.ts 428 --rule R1   # 改善タイプを指定（既定R4=導線改善）
 *
 * --post は生成をやり直すため、レビューした内容と投稿される内容は別物になる。
 * 中身を確認してから投稿したい場合は --post-saved を使う。
 *
 * 元記事は読むだけで変更しない。生成物は必ず別の新規下書きとして投稿する。
 */
import "dotenv/config";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  fetchWpSnapshot,
  fetchPostContent,
  fetchAffiliateShortcodes,
  insertableShortcodes,
  createDraft,
} from "../src/fetch/wp.ts";
import { resolveShortcodeProducts, attachProducts } from "../src/fetch/shortcodeProducts.ts";
import { fetchMediaLibrary } from "../src/fetch/media.ts";
import { buildPhotoCatalog, insertablePhotos } from "../src/generate/photoCatalog.ts";
import { generateDraftSync } from "../src/generate/draft.ts";
import { fetchGscData } from "../src/fetch/gsc.ts";
import { aggregateByUrl } from "../src/analyze/aggregate.ts";
import { normalizeUrl } from "../src/util/urlNormalize.ts";
import { log } from "../src/util/logger.ts";
import { CONFIG } from "../src/config.ts";
import type { Candidate, RewriteRule } from "../src/analyze/types.ts";

const args = process.argv.slice(2);
const POST = args.includes("--post");
const POST_SAVED = args.includes("--post-saved");
const id = Number(args.find((a) => /^\d+$/.test(a)));
if (!id) throw new Error("記事IDを指定してください（例: npx tsx scripts/rewriteArticle.ts 428）");

// 保存済みの生成結果をそのまま投稿する（レビューした内容と投稿内容を一致させる）
if (POST_SAVED) {
  const file = `rewrite-${id}.html`;
  if (!existsSync(file)) throw new Error(`${file} がありません。先に生成してください。`);
  const html = readFileSync(file, "utf8");
  const { fetchWpSnapshot: snap, fetchPostContent: get, createDraft: create } = await import("../src/fetch/wp.ts");
  const s = await snap();
  const target = s.publish.find((p) => p.id === id);
  if (!target) throw new Error(`公開記事に id=${id} が見つかりません`);
  const t = await get(id);
  const created = await create({ title: `【AI提案/リライト】${t.title}`, contentHtml: html });
  console.log(`保存済みの内容を投稿しました: id=${created.id} status=${created.status}`);
  console.log(`ショートコード: ${JSON.stringify(html.match(/\[affi[^\]]*\]/g) ?? [])}`);
  console.log(created.editLink ?? "");
  process.exit(0);
}
const ruleArg = args[args.indexOf("--rule") + 1];
const rule: RewriteRule = (["R1", "R2", "R3", "R4"].includes(ruleArg) ? ruleArg : "R4") as RewriteRule;

const wp = await fetchWpSnapshot();
const ref = wp.publish.find((p) => p.id === id);
if (!ref) throw new Error(`公開記事に id=${id} が見つかりません`);

const orig = await fetchPostContent(id);
const affiCount = (orig.contentHtml.match(/\[affi[^\]]*\]/g) ?? []).length;

// 実データがあれば使う（無ければ空のまま。プロンプトは metrics 無しでも成立する）
const gsc = await fetchGscData();
const agg = aggregateByUrl(gsc.current, gsc.currentPages).get(normalizeUrl(ref.link));
const queries = agg?.queries.slice(0, 4).map((q) => q.query) ?? [];

const candidate: Candidate = {
  type: "rewrite",
  rule,
  targetUrl: normalizeUrl(ref.link),
  wpPostId: id,
  queries: queries.length ? queries : [ref.title.slice(0, 20)],
  score: 0,
  metrics: agg
    ? { position: agg.position, ctr: agg.ctr, impressions: agg.impressions, clicks: agg.clicks }
    : {},
  reason: `手動リライト(${rule}) | アフィリンク${affiCount}本 | 表示${agg?.impressions ?? 0}`,
};

const rawCatalog = await fetchAffiliateShortcodes(wp);
const affiliateCatalog = insertableShortcodes(attachProducts(rawCatalog, await resolveShortcodeProducts(rawCatalog, CONFIG.wp.baseUrl)));
const media = await fetchMediaLibrary();
const photos = insertablePhotos(await buildPhotoCatalog(media));

log.info("手動リライトを生成します", {
  id, rule, title: ref.title.slice(0, 30), 現在のアフィリンク: affiCount, 表示: agg?.impressions ?? 0, 写真候補: photos.length,
});

const draft = await generateDraftSync(candidate, {
  originalTitle: orig.title,
  originalHtml: orig.contentHtml,
  affiliateCatalog,
  photos,
  media,
});

const html = draft.contentHtml;
const valid = new Set(affiliateCatalog.map((s) => s.code));
const codes = html.match(/\[affi[^\]]*\]/g) ?? [];
console.log(`\nタイトル: ${draft.title}`);
console.log(`本文長: ${html.length} / outTokens: ${draft.usage.outputTokens}`);
console.log(`ショートコード: ${codes.length}本 ${JSON.stringify(codes)}（元記事 ${affiCount}本）`);
console.log(`カタログ外ID: ${JSON.stringify(codes.filter((c) => !valid.has(c)))}`);
console.log(`価格金額: ${JSON.stringify(html.match(/[0-9０-９,，]+\s*円|[0-9０-９.]+\s*万円/g) ?? [])}`);
console.log(`断定的効能表現: ${JSON.stringify(html.match(/治る|治療|必ず痩せ|効きます|改善します|完治/g) ?? [])}`);
console.log(`FAQブロック: ${(html.match(/<!-- wp:cocoon-blocks\/faq/g) ?? []).length}件`);
console.log(`【要確認】: ${(html.match(/【要確認[^】]*】/g) ?? []).length}件`);
console.log(`\n変更点サマリー:\n${draft.changeSummary ?? "-"}`);
console.log(`\nタイトル案:\n${(draft.titleSuggestions ?? []).map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`);

writeFileSync(`rewrite-${id}.html`, html);
console.log(`\n本文を rewrite-${id}.html に保存しました。`);

if (!POST) {
  console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。");
  process.exit(0);
}
const created = await createDraft({ title: draft.title, contentHtml: html });
console.log(`\n新規下書きとして投稿しました: id=${created.id} status=${created.status}`);
console.log(created.editLink ?? "");
