/**
 * 既存記事への部分追記（全文リライトをしない改善）。
 *
 * 稼いでいる記事は全文リライトのリスクが見合わない。
 * 取りこぼしているクエリ向けのセクションだけを足し、既存本文はそのまま残す。
 *
 *   npx tsx scripts/appendToArticle.ts 28              # 生成してレビュー表示のみ
 *   npx tsx scripts/appendToArticle.ts 28 --post       # 新規下書きとして投稿
 *   npx tsx scripts/appendToArticle.ts 28 --maxpos 20  # 何位以下を取りこぼしとみなすか（既定15）
 *
 * 元記事は読むだけで変更しない。生成物は別の新規下書きとして投稿する。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import {
  fetchWpSnapshot,
  fetchPostContent,
  fetchAffiliateShortcodes,
  insertableShortcodes,
  createDraft,
} from "../src/fetch/wp.ts";
import { resolveShortcodeProducts, attachProducts } from "../src/fetch/shortcodeProducts.ts";
import { getGoogleAuth } from "../src/fetch/googleAuth.ts";
import {
  buildAppendPrompt,
  parseSections,
  spliceSections,
  verifyOriginalPreserved,
  listH2,
} from "../src/generate/appendSections.ts";
import { sanitizeAffiliateCodes } from "../src/generate/sanitize.ts";
import { fetchMediaLibrary } from "../src/fetch/media.ts";
import { buildPhotoCatalog, insertablePhotos } from "../src/generate/photoCatalog.ts";
import { applyPhotoMarkers, stripForeignImages } from "../src/generate/photoInsert.ts";
import { toCocoonFaqBlocks } from "../src/generate/cocoonFaq.ts";
import { COMPLIANCE_GUIDE } from "../src/generate/prompts.ts";
import { CONFIG } from "../src/config.ts";
import { log } from "../src/util/logger.ts";

const args = process.argv.slice(2);
const POST = args.includes("--post");
const id = Number(args.find((a) => /^\d+$/.test(a)));
if (!id) throw new Error("記事IDを指定してください（例: npx tsx scripts/appendToArticle.ts 28）");
const maxPosIdx = args.indexOf("--maxpos");
const MIN_POSITION = maxPosIdx >= 0 ? Number(args[maxPosIdx + 1]) : 15;

const wp = await fetchWpSnapshot();
const ref = wp.publish.find((p) => p.id === id);
if (!ref) throw new Error(`公開記事に id=${id} が見つかりません`);
const orig = await fetchPostContent(id);
const selfPath = new URL(ref.link).pathname.replace(/\/+$/, "");

// 取りこぼしクエリ = この記事が拾っているが順位が低い、またはクリック0のもの
const wm = google.webmasters({ version: "v3", auth: getGoogleAuth() });
const d = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const res = await wm.searchanalytics.query({
  siteUrl: CONFIG.google.gscSiteUrl,
  requestBody: { startDate: d(120), endDate: d(3), dimensions: ["page", "query"], rowLimit: 25000, dataState: "final" },
});
const mine = (res.data.rows ?? []).filter(
  (r) => new URL(String(r.keys?.[0])).pathname.replace(/\/+$/, "") === selfPath,
);
// #toc 等のフラグメントURLが別行で返るため、クエリ単位に畳み込む（表示最大の行を採用）
const byQuery = new Map<string, { query: string; impressions: number; clicks: number; position: number }>();
for (const r of mine) {
  const query = String(r.keys?.[1] ?? "");
  const row = { query, impressions: r.impressions ?? 0, clicks: r.clicks ?? 0, position: r.position ?? 0 };
  const prev = byQuery.get(query);
  if (!prev || row.impressions > prev.impressions) byQuery.set(query, row);
}
const missed = [...byQuery.values()]
  .filter((q) => q.position > MIN_POSITION || (q.clicks === 0 && q.impressions >= 3))
  .sort((a, b) => b.impressions - a.impressions)
  .slice(0, 12);

if (missed.length === 0) throw new Error("取りこぼしクエリが見つかりませんでした（--maxpos を調整してください）");

const rawCatalog = await fetchAffiliateShortcodes(wp);
const catalog = insertableShortcodes(attachProducts(rawCatalog, await resolveShortcodeProducts(rawCatalog, CONFIG.wp.baseUrl)));

const media = await fetchMediaLibrary();
const photos = insertablePhotos(await buildPhotoCatalog(media));

log.info("部分追記を生成します", {
  id, title: ref.title.slice(0, 30), 既存h2: listH2(orig.contentHtml).length, 取りこぼしクエリ: missed.length, 写真候補: photos.length,
});
console.log("\n=== 狙うクエリ ===");
for (const q of missed) console.log(`  表示${String(q.impressions).padStart(3)} クリック${String(q.clicks).padStart(2)} ${q.position.toFixed(1).padStart(5)}位  "${q.query}"`);

const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });
const msg = await client.messages
  .stream({
    model: CONFIG.anthropic.model,
    max_tokens: 16000,
    thinking: { type: "disabled" as const },
    system: COMPLIANCE_GUIDE,
    messages: [{ role: "user", content: buildAppendPrompt(ref.title, orig.contentHtml, missed, catalog, photos) }],
  })
  .finalMessage();
const text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");

const sections = parseSections(text);
if (sections.length === 0) throw new Error("追加セクションを解析できませんでした");

// 後処理は「追加セクションだけ」に適用する。
// 全文に適用すると既存FAQのマークアップまで変わり、元記事の保持が崩れる。
const removedCodes: string[] = [];
const insertedPhotos: number[] = [];
const cleaned = sections.map((s) => {
  const san = sanitizeAffiliateCodes(s.bodyHtml, catalog, undefined);
  removedCodes.push(...san.removed);
  const ph = applyPhotoMarkers(san.html, photos, media);
  if (ph.inserted.length) insertedPhotos.push(...ph.inserted);
  if (ph.rejected.length) log.warn("カタログ外の写真指定を除去", { ids: ph.rejected });
  const noForeign = stripForeignImages(ph.html, CONFIG.wp.baseUrl).html;
  return { ...s, bodyHtml: toCocoonFaqBlocks(noForeign).html };
});
if (removedCodes.length) log.warn("カタログ外のショートコードを除去", { removed: removedCodes });
const result = spliceSections(orig.contentHtml, cleaned);

// ── 検証 ──
const check = verifyOriginalPreserved(orig.contentHtml, result);
const text0 = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, "");
const addedChars = text0(result).length - text0(orig.contentHtml).length;

console.log(`\n=== 追加セクション ${sections.length}件 ===`);
const h2s = listH2(orig.contentHtml);
for (const s of sections) {
  const where = s.afterH2Index !== null && h2s[s.afterH2Index] ? `「${h2s[s.afterH2Index]}」の後` : "末尾";
  console.log(`  [${where}] ${s.heading}`);
}
console.log(`\n元記事の保持: ${check.ok ? "✅ 完全に保持" : "❌ " + check.reason}`);
console.log(`本文: ${text0(orig.contentHtml).length}字 → ${text0(result).length}字（+${addedChars}字）`);
console.log(`ショートコード: ${JSON.stringify(orig.contentHtml.match(/\[affi[^\]]*\]/g) ?? [])} → ${JSON.stringify(result.match(/\[affi[^\]]*\]/g) ?? [])}`);

// 既存記事にも該当表現がありうるので、**追加分で増えた件数**だけを見る。
// 「治療を目的としたものではありません」のような否定文は問題ないため、文脈も併せて出す。
const addedText = cleaned.map((s) => s.heading + s.bodyHtml.replace(/<[^>]+>/g, "")).join("\n");
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length;
const PRICE = /[0-9０-９,，]+\s*円|[0-9０-９.]+\s*万円/g;
const NG = /治る|治療|必ず痩せ|効きます|改善します|完治/g;
console.log(`価格金額: 元記事${count(orig.contentHtml, PRICE)}件 → 追記後${count(result, PRICE)}件（追加分 ${count(addedText, PRICE)}件）`);
console.log(`要注意表現: 元記事${count(orig.contentHtml, NG)}件 → 追記後${count(result, NG)}件（追加分 ${count(addedText, NG)}件）`);
for (const m of addedText.matchAll(NG)) {
  console.log(`   文脈: …${addedText.slice(Math.max(0, m.index - 45), m.index + 28).replace(/\s+/g, " ")}…`);
}

writeFileSync(`append-${id}.html`, result);
console.log(`\n本文を append-${id}.html に保存しました。`);

if (!check.ok) throw new Error("元記事が保持されていないため中止します");
if (!POST) {
  console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。");
  process.exit(0);
}
const created = await createDraft({ title: `【AI提案/追記】${ref.title}`, contentHtml: result });
console.log(`\n新規下書きとして投稿しました: id=${created.id} status=${created.status}`);
console.log(created.editLink ?? "");
