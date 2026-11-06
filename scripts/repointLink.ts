/**
 * 記事内の内部リンクを別URLに張り替えた下書きを作る（統合でURLを畳むときの後始末）。
 *
 * 301リダイレクトを張れば読者は飛べるが、リンク元が古いURLを指したままだと
 * 評価が1回余計に経由する。畳む前にリンク元を直接の宛先に向け直しておく。
 *
 *   npx tsx scripts/repointLink.ts 532 --from /recoverywear_dryingmachine/ --to /howtowash-recoverywear/ --text "リカバリーウェアの洗濯方法｜乾燥機NGの理由と長持ちさせるコツ"
 *   ... --post   # 新規下書きとして投稿
 *
 * 元記事は読むだけで変更しない。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { fetchPostContent, createDraft } from "../src/fetch/wp.ts";
import { CONFIG } from "../src/config.ts";

const args = process.argv.slice(2);
const POST = args.includes("--post");
const id = Number(args.find((a) => /^\d+$/.test(a)));
const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const from = val("--from");
const to = val("--to");
const text = val("--text");
if (!id || !from || !to) throw new Error("使い方: repointLink.ts <id> --from <path> --to <path> [--text <アンカー文言>]");

const abs = (p: string) => (p.startsWith("http") ? p : CONFIG.wp.baseUrl + p);
const orig = await fetchPostContent(id);
let html = orig.contentHtml;

/** 正規表現のメタ文字を無効化する */
const esc = (s: string) => s.replace(/[.*+?^$|()\[\]{}\\\/\-]/g, (c) => "\\" + c);

// <a href="from">任意のテキスト</a> を丸ごと置換（アンカー文言も宛先に合わせる）
const re = new RegExp('<a href="' + esc(abs(from)) + '"[^>]*>(.*?)<\\/a>', "gs");
const hits = [...html.matchAll(re)];
if (!hits.length) throw new Error(`${from} へのリンクが見つかりません`);
for (const m of hits) console.log(`張り替え: 「${m[1].replace(/<[^>]*>/g, "").slice(0, 40)}」`);
html = html.replace(re, (_m, inner) => `<a href="${abs(to)}">${text ?? inner}</a>`);

const strip = (h: string) => h.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
console.log(`\n件数: ${hits.length}件 / 本文 ${strip(orig.contentHtml)}字 → ${strip(html)}字`);
console.log(`残存する ${from} へのリンク: ${(html.match(new RegExp(esc(abs(from)), "g")) ?? []).length}件`);
console.log(`ショートコード: ${JSON.stringify(html.match(/\[affi[^\]]*\]/g) ?? [])}`);

writeFileSync(`repoint-${id}.html`, html);
console.log(`repoint-${id}.html に保存しました。`);
if (!POST) { console.log("※ 投稿はしていません。--post を付けると新規下書きとして投稿します。"); process.exit(0); }
const created = await createDraft({ title: `【AI提案/リンク修正】${orig.title}`, contentHtml: html, proposal: { typeLabel: "リンク修正", targetUrl: orig.link! } });
console.log(`\n新規下書きとして投稿しました: id=${created.id}`);
console.log(created.editLink ?? "");
