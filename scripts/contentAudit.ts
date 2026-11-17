/**
 * 長く更新していない公開記事の棚卸し。記事ごとに「残して改善／統合／置いておく」を決める材料を並べる。
 *
 * 記事が古いこと自体でサイトの評価が下がるわけではない。問題になりうるのは、読まれず Google にも
 * 登録されない記事がまとまってあること（実測 2026-11: 40本中18本が未登録、うち9本は見た上で見送り）。
 * そこで古さではなく、登録状況・半年間の表示と流入・被リンク・サイトの主題との近さ・他記事との
 * 内容の重なりを記事ごとに出す。
 *
 * 統合の可否は CLAUDE.md のとおり、見出しの類似度だけで決めず、クエリが実際にどちらへ落ちているかを
 * 合わせて見る（ここでは両方の上位クエリを並べる）。
 *
 *   npx tsx scripts/contentAudit.ts               # 最終更新が6か月以上前の記事
 *   npx tsx scripts/contentAudit.ts --months 3    # しきい値を変える
 *
 * 記事は読むだけで変更しない。結果は audit-YYYY-MM-DD.json にも書き出す。
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { google } from "googleapis";
import { fetchWpSnapshot, fetchPostContent, fetchAffiliateShortcodes, lastInternalLinks } from "../src/fetch/wp.ts";
import { bigrams, dice } from "../src/analyze/internalLinks.ts";
import { getGoogleAuth } from "../src/fetch/googleAuth.ts";
import { normalizeUrl } from "../src/util/urlNormalize.ts";
import { CONFIG } from "../src/config.ts";

const mIdx = process.argv.indexOf("--months");
const MONTHS = mIdx >= 0 ? Number(process.argv[mIdx + 1]) : 6;
const DAY = 864e5;
const today = new Date();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
// 表示と流入は直近半年で見る（28日だと、読まれない記事どうしの差が出ない）
const range = { startDate: ymd(new Date(today.getTime() - 183 * DAY)), endDate: ymd(new Date(today.getTime() - 3 * DAY)) };
const MONEY = ["/bakune-review", "/venex-review", "/bakune-or-venex", "/recommendation", "/best-bakune"];
const pathOf = (u: string) => new URL(u).pathname.replace(/\/+$/, "") || "/";

// ── 記事本文（全記事。重なりは全体と比べる）
const wp = await fetchWpSnapshot();
await fetchAffiliateShortcodes(wp); // lastInternalLinks を埋める副作用
const res = await fetch(`${CONFIG.wp.baseUrl}/wp-json/wp/v2/posts?per_page=100&status=publish&_fields=id,modified`);
const modified = new Map(((await res.json()) as Array<{ id: number; modified: string }>).map((p) => [p.id, p.modified]));

interface Doc {
  id: number; path: string; title: string; modified: string; chars: number; headings: string[];
  sig: Set<string>; wearMentions: number; affi: number; moneyLinks: string[];
}
const docs: Doc[] = [];
for (const p of wp.publish) {
  const c = await fetchPostContent(p.id);
  const headings = [...c.contentHtml.matchAll(/<h[23][^>]*>(.*?)<\/h[23]>/gs)].map((m) => m[1].replace(/<[^>]*>/g, "").trim());
  const text = c.contentHtml.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  const path = pathOf(p.link);
  const links = [...c.contentHtml.matchAll(/href="https?:\/\/recovery-wear-guide\.com(\/[^"#?]*)"/g)].map((m) => m[1].replace(/\/+$/, ""));
  docs.push({
    id: p.id, path, title: p.title, modified: (modified.get(p.id) ?? "").slice(0, 10), chars: text.length, headings,
    sig: bigrams([p.title, ...headings].join(" ")),
    wearMentions: (text.match(/リカバリー\s*ウェア/g) ?? []).length,
    affi: (c.contentHtml.match(/\[affi id=\d+\]/g) ?? []).length,
    moneyLinks: [...new Set(links.filter((l) => MONEY.includes(l) && l !== path))],
  });
  process.stderr.write(".");
}
process.stderr.write("\n");

// ── Google: 半年間の表示（page 次元が正）と、上位クエリ（page+query）
const auth = getGoogleAuth();
const sc = google.searchconsole({ version: "v1", auth });
const pageRows = await sc.searchanalytics.query({ siteUrl: CONFIG.google.gscSiteUrl, requestBody: { ...range, dimensions: ["page"], rowLimit: 25000 } });
const gsc = new Map<string, { imp: number; clk: number; pos: number }>();
for (const r of pageRows.data.rows ?? []) {
  const p = pathOf(normalizeUrl(r.keys![0]));
  const prev = gsc.get(p);
  if (!prev || (r.impressions ?? 0) > prev.imp) gsc.set(p, { imp: r.impressions ?? 0, clk: r.clicks ?? 0, pos: r.position ?? 0 });
}
const qRows = await sc.searchanalytics.query({ siteUrl: CONFIG.google.gscSiteUrl, requestBody: { ...range, dimensions: ["page", "query"], rowLimit: 25000 } });
const queries = new Map<string, Array<{ q: string; imp: number }>>();
for (const r of qRows.data.rows ?? []) {
  const p = pathOf(normalizeUrl(r.keys![0]));
  queries.set(p, [...(queries.get(p) ?? []), { q: r.keys![1], imp: r.impressions ?? 0 }]);
}
for (const v of queries.values()) v.sort((a, b) => b.imp - a.imp);

// ── GA4: 半年間のセッション（検索エンジンを問わない）
const ga = google.analyticsdata({ version: "v1beta", auth });
const gaRes = await ga.properties.runReport({
  property: `properties/${CONFIG.google.ga4PropertyId}`,
  requestBody: { dateRanges: [range], dimensions: [{ name: "pagePath" }], metrics: [{ name: "sessions" }], limit: "10000" },
});
const sessions = new Map<string, number>();
for (const r of gaRes.data.rows ?? []) {
  const p = (r.dimensionValues![0].value ?? "").replace(/\/+$/, "") || "/";
  sessions.set(p, (sessions.get(p) ?? 0) + Number(r.metricValues![0].value));
}

// ── 対象（最終更新が MONTHS か月以上前）の登録状況を今の値で照会する
const cutoff = new Date(today.getTime() - MONTHS * 30.4 * DAY).toISOString().slice(0, 10);
const targets = docs.filter((d) => d.modified && d.modified < cutoff);
const coverage = new Map<string, { state: string; lastCrawl: string | null }>();
for (const d of targets) {
  const r = await sc.urlInspection.index.inspect({
    requestBody: { inspectionUrl: `${CONFIG.wp.baseUrl}${d.path}/`, siteUrl: CONFIG.google.gscSiteUrl, languageCode: "en" },
  });
  const s = r.data.inspectionResult?.indexStatusResult;
  coverage.set(d.path, { state: s?.coverageState ?? "-", lastCrawl: s?.lastCrawlTime?.slice(0, 10) ?? null });
  await new Promise((ok) => setTimeout(ok, 250));
}

// ── 被リンク: 全体の本数と、Google に表示実績のある記事からの本数（＝生きた経路）
const live = new Set([...gsc.entries()].filter(([, v]) => v.imp > 0).map(([p]) => p));
const inbound = (p: string) => {
  const from = lastInternalLinks.filter((n) => n.path !== p && n.outbound.includes(p)).map((n) => n.path);
  return { all: from.length, live: from.filter((f) => live.has(f)).length };
};

const SHORT: Record<string, string> = {
  "Submitted and indexed": "登録済み",
  "Indexed, not submitted in sitemap": "登録済み",
  "Crawled - currently not indexed": "見送り",
  "Discovered - currently not indexed": "未クロール",
  "URL is unknown to Google": "Google未認識",
};

const rows = targets.map((d) => {
  const best = docs
    .filter((o) => o.path !== d.path)
    .map((o) => ({ o, s: dice(d.sig, o.sig) }))
    .sort((a, b) => b.s - a.s)[0];
  const common = d.headings.filter((h) => best.o.headings.some((g) => dice(bigrams(h), bigrams(g)) >= 0.5));
  const cov = coverage.get(d.path)!;
  return {
    path: d.path, id: d.id, title: d.title, modified: d.modified, chars: d.chars,
    coverage: SHORT[cov.state] ?? cov.state, lastCrawl: cov.lastCrawl,
    gsc: gsc.get(d.path) ?? { imp: 0, clk: 0, pos: 0 },
    topQueries: (queries.get(d.path) ?? []).slice(0, 3),
    sessions: sessions.get(d.path) ?? 0,
    inbound: inbound(d.path),
    wearMentions: d.wearMentions, affi: d.affi, moneyLinks: d.moneyLinks,
    overlap: {
      path: best.o.path, score: Math.round(best.s * 1000) / 1000, commonHeadings: common.length,
      partnerImp: gsc.get(best.o.path)?.imp ?? 0,
      partnerTopQueries: (queries.get(best.o.path) ?? []).slice(0, 3),
    },
  };
});

const out = `audit-${ymd(today)}.json`;
writeFileSync(out, JSON.stringify({ range, months: MONTHS, rows }, null, 2));

console.log(`\n対象: 最終更新が${MONTHS}か月以上前の記事 ${rows.length}本 / 全${docs.length}本（表示・流入は ${range.startDate}〜${range.endDate}）\n`);
for (const r of rows.sort((a, b) => b.gsc.imp - a.gsc.imp || b.sessions - a.sessions)) {
  console.log(`${r.path}  [${r.coverage}${r.lastCrawl ? ` ${r.lastCrawl}` : ""}]  更新${r.modified} ${r.chars}字`);
  console.log(`   ${r.title.slice(0, 48)}`);
  console.log(`   半年: 表示${r.gsc.imp} クリック${r.gsc.clk}${r.gsc.imp ? ` 順位${r.gsc.pos.toFixed(1)}` : ""} / セッション${r.sessions}  被リンク${r.inbound.all}（生きた経路${r.inbound.live}）`);
  console.log(`   主題: 「リカバリーウェア」${r.wearMentions}回 affi${r.affi} 稼ぐ記事へのリンク${r.moneyLinks.length ? r.moneyLinks.join(",") : "なし"}`);
  if (r.topQueries.length) console.log(`   クエリ: ${r.topQueries.map((q) => `${q.q}(${q.imp})`).join(" / ")}`);
  console.log(`   最も近い記事: ${r.overlap.path} 類似${r.overlap.score} 共通見出し${r.overlap.commonHeadings} 相手の表示${r.overlap.partnerImp}`);
}
console.log(`\n${out} に書き出しました。`);
