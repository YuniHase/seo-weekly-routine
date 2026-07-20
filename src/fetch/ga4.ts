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
import type { Ga4Row } from "../analyze/types.ts";

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
