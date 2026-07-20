/**
 * Google Search Console API（主データ）。
 * サービスアカウントJWT認証。直近28日 と 前28日 の2本を取得（前期比較用）。
 *
 * 期間はGSCデータ遅延（§8-E）を考慮し、終端 = 実行日 - DATA_DELAY_DAYS。
 * ディメンション: page, query / 指標: clicks, impressions, ctr, position / rowLimit: 5000
 */
import { google } from "googleapis";
import { CONFIG } from "../config.ts";
import { getGoogleAuth } from "./googleAuth.ts";
import { analysisPeriods, type Period } from "../util/dateRange.ts";
import { log } from "../util/logger.ts";
import type { GscRow } from "../analyze/types.ts";

export interface GscPeriods {
  current: GscRow[]; // 直近28日
  previous: GscRow[]; // その前28日
  currentPeriod: Period;
  previousPeriod: Period;
}

async function queryPeriod(period: Period): Promise<GscRow[]> {
  const wm = google.webmasters({ version: "v3", auth: getGoogleAuth() });
  const res = await wm.searchanalytics.query({
    siteUrl: CONFIG.google.gscSiteUrl,
    requestBody: {
      startDate: period.startDate,
      endDate: period.endDate,
      dimensions: ["page", "query"],
      rowLimit: 5000,
      dataState: "final",
    },
  });
  const rows = res.data.rows ?? [];
  return rows.map((r): GscRow => ({
    page: r.keys?.[0] ?? "",
    query: r.keys?.[1] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    ctr: r.ctr ?? 0,
    position: r.position ?? 0,
  }));
}

export async function fetchGscData(): Promise<GscPeriods> {
  const { current, previous } = analysisPeriods(CONFIG.run.lookbackDays, CONFIG.run.dataDelayDays);
  log.info("GSC取得期間", { current, previous, site: CONFIG.google.gscSiteUrl });
  const [cur, prev] = await Promise.all([queryPeriod(current), queryPeriod(previous)]);
  log.info("GSC取得完了", { currentRows: cur.length, previousRows: prev.length });
  return { current: cur, previous: prev, currentPeriod: current, previousPeriod: previous };
}
