/**
 * 分析期間の算出。
 * GSCデータは確定まで2〜3日遅延する（§8-E）ため、終端は「実行日 - DATA_DELAY_DAYS」。
 * そこから LOOKBACK_DAYS 日ぶんを直近期間、その直前の同じ日数を前期比較期間とする。
 */
export interface Period {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUTC(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

/**
 * @param lookbackDays 分析日数（例: 28）
 * @param dataDelayDays 終端を実行日から何日前にするか（例: 3）
 * @param today 基準日（省略時は現在UTC。テスト用に注入可能）
 */
export function analysisPeriods(
  lookbackDays: number,
  dataDelayDays: number,
  today: Date = new Date(),
): { current: Period; previous: Period } {
  const end = addDaysUTC(today, -dataDelayDays);
  const start = addDaysUTC(end, -(lookbackDays - 1));
  const prevEnd = addDaysUTC(start, -1);
  const prevStart = addDaysUTC(prevEnd, -(lookbackDays - 1));
  return {
    current: { startDate: fmt(start), endDate: fmt(end) },
    previous: { startDate: fmt(prevStart), endDate: fmt(prevEnd) },
  };
}
