/**
 * 全公開記事のインデックス（クロール）状況を一覧する。
 *
 * GSC URL Inspection API は「Googleがそのページをどう扱っているか」を返す唯一のAPI。
 * 検索表示が0の記事は、順位が低いのか、そもそもインデックスされていないのかを
 * 検索パフォーマンスのデータだけでは区別できない。ここで切り分ける。
 *
 *   npx tsx scripts/indexStatus.ts            # 全公開記事
 *   npx tsx scripts/indexStatus.ts --json     # 機械可読（data/indexStatus.json にも保存）
 *
 * 注意: このAPIは「インデックス登録のリクエスト」はできない（読み取り専用）。
 * 未登録URLの登録申請は Search Console の画面からの手動操作が必要。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { google } from "googleapis";
import { fetchWpSnapshot } from "../src/fetch/wp.ts";
import { fetchGscData } from "../src/fetch/gsc.ts";
import { aggregateByUrl } from "../src/analyze/aggregate.ts";
import { normalizeUrl } from "../src/util/urlNormalize.ts";
import { getGoogleAuth } from "../src/fetch/googleAuth.ts";
import { CONFIG } from "../src/config.ts";
import { log } from "../src/util/logger.ts";

const JSON_OUT = process.argv.includes("--json");

interface Row {
  id: number;
  title: string;
  url: string;
  verdict: string;        // PASS / NEUTRAL / FAIL
  coverage: string;       // 「送信して登録済み」など日本語の説明文
  lastCrawl: string | null;
  canonicalMismatch: boolean;
  impressions: number;
  clicks: number;
  error?: string;
}

const sc = google.searchconsole({ version: "v1", auth: getGoogleAuth() });

async function inspect(url: string): Promise<Partial<Row>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await sc.urlInspection.index.inspect({
        requestBody: { inspectionUrl: url, siteUrl: CONFIG.google.gscSiteUrl, languageCode: "ja" },
      });
      const r = res.data.inspectionResult?.indexStatusResult ?? {};
      const userCanonical = (r.userCanonical ?? "").replace(/\/+$/, "");
      const googleCanonical = (r.googleCanonical ?? "").replace(/\/+$/, "");
      return {
        verdict: r.verdict ?? "-",
        coverage: r.coverageState ?? "-",
        lastCrawl: r.lastCrawlTime ?? null,
        canonicalMismatch: !!googleCanonical && !!userCanonical && googleCanonical !== userCanonical,
      };
    } catch (e: any) {
      const code = e?.code ?? e?.response?.status;
      if (code === 429 || code === 503) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return { verdict: "ERROR", coverage: "-", error: e?.message ?? String(e) };
    }
  }
  return { verdict: "ERROR", coverage: "-", error: "リトライ上限" };
}

const wp = await fetchWpSnapshot();
const gsc = await fetchGscData();
const agg = aggregateByUrl(gsc.current, gsc.currentPages);

log.info("インデックス状況を照会します", { 公開記事数: wp.publish.length });

const rows: Row[] = [];
for (const p of wp.publish) {
  const norm = normalizeUrl(p.link);
  const m = agg.get(norm);
  const r = await inspect(p.link);
  rows.push({
    id: p.id,
    title: p.title,
    url: norm,
    verdict: r.verdict ?? "-",
    coverage: r.coverage ?? "-",
    lastCrawl: r.lastCrawl ?? null,
    canonicalMismatch: !!r.canonicalMismatch,
    impressions: m?.impressions ?? 0,
    clicks: m?.clicks ?? 0,
    error: r.error,
  });
  process.stderr.write(".");
  await new Promise((r) => setTimeout(r, 250)); // 600req/分の上限に余裕を持たせる
}
process.stderr.write("\n");

const jp = (c: string) =>
  ({
    "Submitted and indexed": "✅ 送信して登録済み",
    Indexed: "✅ 登録済み",
    "Indexed, not submitted in sitemap": "✅ 登録済み(サイトマップ未送信)",
    "Discovered - currently not indexed": "⛔ 発見済み・未クロール",
    "Crawled - currently not indexed": "⚠️ クロール済み・未登録",
    "Duplicate without user-selected canonical": "🔁 重複(正規URL未指定)",
    "Duplicate, Google chose different canonical than user": "🔁 重複(Googleが別URLを正規と判断)",
    "Alternate page with proper canonical tag": "🔁 別URLの正規扱い",
    "Page with redirect": "↪️ リダイレクト",
    "URL is unknown to Google": "❓ Google未認識",
  })[c] ?? c;

const days = (iso: string | null) =>
  iso ? `${Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)}日前` : "クロールなし";

const order = (r: Row) => (r.verdict === "PASS" ? 2 : r.verdict === "ERROR" ? 1 : 0);
rows.sort((a, b) => order(a) - order(b) || b.impressions - a.impressions);

const ok = rows.filter((r) => r.verdict === "PASS");
const ng = rows.filter((r) => r.verdict !== "PASS" && r.verdict !== "ERROR");
const err = rows.filter((r) => r.verdict === "ERROR");

console.log(`\n全公開記事 ${rows.length}件 / インデックス済み ${ok.length}件 / 未登録 ${ng.length}件${err.length ? ` / 照会失敗 ${err.length}件` : ""}\n`);

if (ng.length) {
  console.log("── ⚠️ インデックスされていない記事 ".padEnd(60, "─"));
  for (const r of ng) {
    console.log(`\n  ${r.title.slice(0, 44)}`);
    console.log(`    ${r.url}`);
    console.log(`    ${jp(r.coverage)} / 最終クロール: ${days(r.lastCrawl)} / 直近28日 表示${r.impressions}・クリック${r.clicks}`);
    if (r.canonicalMismatch) console.log(`    ⚠️ Googleが別URLを正規と判断しています`);
  }
  console.log("");
}

console.log("── ✅ インデックス済み ".padEnd(60, "─"));
for (const r of ok) {
  const flag = r.canonicalMismatch ? " ⚠️正規URL不一致" : "";
  console.log(`  表示${String(r.impressions).padStart(5)} / ${days(r.lastCrawl).padStart(9)} / ${jp(r.coverage).padEnd(16)} ${r.title.slice(0, 32)}${flag}`);
}

if (err.length) {
  console.log("\n── 照会失敗 ".padEnd(60, "─"));
  for (const r of err) console.log(`  ${r.title.slice(0, 40)}: ${r.error}`);
}

// クロールが古い＝更新が拾われていない可能性
const stale = ok.filter((r) => r.lastCrawl && Date.now() - new Date(r.lastCrawl).getTime() > 30 * 86400000);
if (stale.length) {
  console.log(`\n── 🕐 30日以上クロールされていない（更新が反映されていない可能性） ${stale.length}件`);
  for (const r of stale) console.log(`  ${days(r.lastCrawl).padStart(9)} / ${r.title.slice(0, 40)}`);
}

writeFileSync("data/indexStatus.json", JSON.stringify({ checkedAt: new Date().toISOString(), rows }, null, 2));
console.log(`\ndata/indexStatus.json に保存しました。`);
if (JSON_OUT) console.log(JSON.stringify(rows, null, 2));
