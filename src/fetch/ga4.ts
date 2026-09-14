/**
 * Google Analytics Data API (GA4)（補助データ）。
 * 直近28日 / ディメンション pagePath / 指標 sessions, engagementRate, averageSessionDuration。
 * 用途: リライト優先度の重み付け（流入があるのに直帰が多い記事を優先）。
 */
import { google } from "googleapis";
import { CONFIG } from "../config.ts";
import { getGoogleAuth } from "./googleAuth.ts";
import { analysisPeriods } from "../util/dateRange.ts";
import { log } from "../util/logger.ts";
import type { Ga4Row, AffiliateClicks } from "../analyze/types.ts";

export async function fetchGa4Data(): Promise<Ga4Row[]> {
  const { current } = analysisPeriods(CONFIG.run.lookbackDays, CONFIG.run.dataDelayDays);
  const data = google.analyticsdata({ version: "v1beta", auth: getGoogleAuth() });
  log.info("GA4取得期間", { current, property: CONFIG.google.ga4PropertyId });
  const res = await data.properties.runReport({
    property: `properties/${CONFIG.google.ga4PropertyId}`,
    requestBody: {
      dateRanges: [{ startDate: current.startDate, endDate: current.endDate }],
      dimensions: [{ name: "pagePath" }],
      metrics: [
        { name: "sessions" },
        { name: "engagementRate" },
        { name: "averageSessionDuration" },
      ],
      limit: "100000",
    },
  });
  const rows = res.data.rows ?? [];
  const mapped = rows.map((r): Ga4Row => ({
    pagePath: r.dimensionValues?.[0]?.value ?? "",
    sessions: Number(r.metricValues?.[0]?.value ?? 0),
    engagementRate: Number(r.metricValues?.[1]?.value ?? 0),
    averageSessionDuration: Number(r.metricValues?.[2]?.value ?? 0),
  }));
  log.info("GA4取得完了", { rows: mapped.length });
  return mapped;
}


/**
 * アフィリエイトリンクのクリック数を記事別に取得する（GA4の拡張計測「外部リンククリック」）。
 *
 * 実売上はAmazon/楽天ともAPIが無く記事別にも紐づかないため、GA4の外部リンククリックを
 * 収益の代理指標として使う。amzn.to / a.r10.to / hb.afl.rakuten.co.jp 等を集計。
 */
export async function fetchAffiliateClicks(): Promise<Map<string, AffiliateClicks>> {
  const { current } = analysisPeriods(CONFIG.run.lookbackDays, CONFIG.run.dataDelayDays);
  const data = google.analyticsdata({ version: "v1beta", auth: getGoogleAuth() });
  const res = await data.properties.runReport({
    property: `properties/${CONFIG.google.ga4PropertyId}`,
    requestBody: {
      dateRanges: [{ startDate: current.startDate, endDate: current.endDate }],
      dimensions: [{ name: "pagePath" }, { name: "linkDomain" }],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: "click" } } },
      limit: "10000",
    },
  });
  const out = new Map<string, AffiliateClicks>();
  for (const r of res.data.rows ?? []) {
    const path = (r.dimensionValues?.[0]?.value ?? "").replace(/\/+$/, "") || "/";
    const domain = (r.dimensionValues?.[1]?.value ?? "").toLowerCase();
    const n = Number(r.metricValues?.[0]?.value ?? 0);
    const isAmazon = domain.includes("amzn.to") || domain.includes("amazon.");
    const isRakuten = domain.includes("r10.to") || domain.includes("rakuten.");
    if (!isAmazon && !isRakuten) continue;
    const cur = out.get(path) ?? { amazon: 0, rakuten: 0, total: 0 };
    if (isAmazon) cur.amazon += n; else cur.rakuten += n;
    cur.total += n;
    out.set(path, cur);
  }
  log.info("アフィリンククリック取得完了", { pages: out.size, total: [...out.values()].reduce((s, v) => s + v.total, 0) });
  return out;
}
