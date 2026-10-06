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
  /**
   * 日次の長期推移（既定180日）。季節のピークと平常時を見分けるために使う。
   *
   * 季節商材は前28日がたまたまピークだと、前期比が実態以上の急落に見える。
   * 実例: 夏クエリ「リカバリーウェア 暑い」が8月末に週36クリックを稼ぎ、
   * 10月には2クリックになった。これは異常ではなく季節の正常な推移。
   * 前年同期比が本来の見方だが、立ち上げ1年目は前年データが無いため、
   * 長期の中央値を平常時の目安として代用する。
   */
  baselineDaily: DailyPoint[];
}

export interface DailyPoint {
  date: string;
  clicks: number;
  impressions: number;
  position: number;
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
  // 季節判定用の長期ベースライン（日次・180日）。1リクエストで済む。
  const baselineStart = new Date(new Date(current.endDate).getTime() - 180 * 864e5).toISOString().slice(0, 10);
  const [cur, prev, curPages, prevPages, daily] = await Promise.all([
    queryPeriod(current),
    queryPeriod(previous),
    queryPeriod(current, ["page"]),
    queryPeriod(previous, ["page"]),
    fetchDaily({ startDate: baselineStart, endDate: current.endDate }),
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
    baselineDaily: daily,
  };
}

/** 日次の推移を取得（季節のピーク判定用） */
async function fetchDaily(period: Period): Promise<DailyPoint[]> {
  const wm = google.webmasters({ version: "v3", auth: getGoogleAuth() });
  const res = await wm.searchanalytics.query({
    siteUrl: CONFIG.google.gscSiteUrl,
    requestBody: {
      startDate: period.startDate,
      endDate: period.endDate,
      dimensions: ["date"],
      rowLimit: 1000,
      dataState: "final",
    },
  });
  return (res.data.rows ?? []).map((r) => ({
    date: r.keys?.[0] ?? "",
    clicks: r.clicks ?? 0,
    impressions: r.impressions ?? 0,
    position: r.position ?? 0,
  }));
}
