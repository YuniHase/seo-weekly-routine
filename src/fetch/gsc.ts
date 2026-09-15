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
  current: GscRow[]; // 直近28日（page+query）
  previous: GscRow[]; // その前28日（page+query）
  /**
   * page次元のみの取得結果（query は空文字）。
   *
   * GSCは検索回数の少ないクエリを匿名化し、query次元を含むリクエストでは
   * その行を返さない。このため page+query の合計は記事の実数を大きく下回る
   * （当サイト実測: 全体で表示回数の67%、記事によっては12%しか捕捉できない）。
   * 記事単位の指標（表示・クリック・順位）はこちらを正とする。
   */
  currentPages: GscRow[];
  previousPages: GscRow[];
  currentPeriod: Period;
  previousPeriod: Period;
}

async function queryPeriod(period: Period, dimensions: string[] = ["page", "query"]): Promise<GscRow[]> {
  const wm = google.webmasters({ version: "v3", auth: getGoogleAuth() });
  const res = await wm.searchanalytics.query({
    siteUrl: CONFIG.google.gscSiteUrl,
    requestBody: {
      startDate: period.startDate,
      endDate: period.endDate,
      dimensions,
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
  const [cur, prev, curPages, prevPages] = await Promise.all([
    queryPeriod(current),
    queryPeriod(previous),
    queryPeriod(current, ["page"]),
    queryPeriod(previous, ["page"]),
  ]);
  const sumImp = (rows: GscRow[]) => rows.reduce((s, r) => s + r.impressions, 0);
  log.info("GSC取得完了", {
    currentRows: cur.length,
    previousRows: prev.length,
    currentPageRows: curPages.length,
    // 匿名化クエリによる取りこぼし率。記事単位の指標は page 次元を正とする
    queryDimCoverage: `${((sumImp(cur) / Math.max(1, sumImp(curPages))) * 100).toFixed(0)}%`,
  });
  return {
    current: cur,
    previous: prev,
    currentPages: curPages,
    previousPages: prevPages,
    currentPeriod: current,
    previousPeriod: previous,
  };
}
