/**
 * 季節の文脈（前期比の読み違いを防ぐための注記）。
 *
 * 季節商材では、前28日がたまたまピークだと前期比が実態以上の急落に見える。
 * 実例: 2026年8月末に夏クエリ「リカバリーウェア 暑い」が週36クリックを稼ぎ、
 * 10月には2クリックになった。サイト全体では -47% だが、これは異常ではなく
 * 季節の正常な推移で、7月の平常時（週41クリック）とほぼ同水準に戻っただけだった。
 *
 * 本来は前年同期比で見るべきだが、立ち上げ1年目は前年データが存在しない。
 * そこで長期（既定180日）の週次中央値を「平常時の水準」として代用し、
 * 前期・今期がそれに対してどの位置にあるかを示す。
 */
import type { DailyPoint } from "../fetch/gsc.ts";

/** 日次データを7日ごとに合算する */
function weeklyTotals(daily: DailyPoint[]): number[] {
  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i += 7) {
    const w = sorted.slice(i, i + 7);
    if (w.length < 7) break; // 端数の週は平常値を歪めるので除く
    out.push(w.reduce((s, d) => s + d.clicks, 0));
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 指定期間の合計クリック */
function sumRange(daily: DailyPoint[], start: string, end: string): number {
  return daily.filter((d) => d.date >= start && d.date <= end).reduce((s, d) => s + d.clicks, 0);
}

export function seasonalContextSection(
  daily: DailyPoint[],
  currentPeriod: { startDate: string; endDate: string },
  previousPeriod: { startDate: string; endDate: string },
): string {
  const weeks = weeklyTotals(daily);
  if (weeks.length < 8) return ""; // データが足りないうちは出さない

  const med = median(weeks);
  const cur = sumRange(daily, currentPeriod.startDate, currentPeriod.endDate);
  const prev = sumRange(daily, previousPeriod.startDate, previousPeriod.endDate);
  if (prev === 0 || med === 0) return "";

  const normal28 = med * 4; // 平常時の28日換算
  const prevRatio = prev / normal28;
  const curRatio = cur / normal28;
  const change = ((cur - prev) / prev) * 100;

  const lines = [
    "## 🗓 季節の文脈（前期比の読み方）",
    "> 季節商材は前期がピークだと、前期比が実態以上の急落に見える。",
    "> 本来は前年同期比で見るべきだが、立ち上げ1年目は前年データが無いため、",
    `> 直近180日の週次中央値（週${med.toFixed(0)}クリック＝28日換算 ${normal28.toFixed(0)}）を平常時の目安として比較する。`,
    "",
    "| | クリック | 平常時との比 |",
    "|---|---|---|",
    `| 前28日 | ${prev} | ${prevRatio.toFixed(2)}倍 |`,
    `| 直近28日 | ${cur} | ${curRatio.toFixed(2)}倍 |`,
    `| 前期比 | ${change >= 0 ? "+" : ""}${change.toFixed(0)}% | |`,
    "",
  ];

  // 読み違いが起きやすいケースだけ、明示的に注意を出す
  if (prevRatio >= 1.4 && curRatio >= 0.8) {
    lines.push(
      `**前期は平常時の${prevRatio.toFixed(1)}倍のピーク期でした。** 直近は平常時の${curRatio.toFixed(2)}倍で、` +
        "水準としては正常な範囲です。前期比の下落幅は実態より大きく見えている点に注意してください。",
      "",
    );
  } else if (curRatio < 0.7) {
    lines.push(
      `⚠️ **直近は平常時の${curRatio.toFixed(2)}倍** まで落ちています。季節要因だけでは説明できない可能性があるため、` +
        "順位の推移や技術的な問題（インデックス状況・サイトの応答）を確認してください。",
      "",
    );
  }

  return lines.join("\n");
}
