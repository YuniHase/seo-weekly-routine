/**
 * 季節プロファイル（商材の繁忙期の定義）。
 *
 * 「冬が本番」のような商材理解は、データからは読み取れない（サイト立ち上げから
 * 1年未満の間は前年同期データが存在しないため）。そこで人間が一度定義し、
 * 以降は機械が日付と突き合わせて判断する。
 *
 * ここを書き換えれば他商材にも転用できる。GSCは16ヶ月分を保持するので、
 * 運用2年目からは実データで peakMonths の妥当性を検証できる（verifyPeaks）。
 *
 * leadMonths（リードタイム）が重要。記事は公開してすぐ上位に出ないため、
 * ピーク月に間に合わせるには何ヶ月前に用意すべきかを持つ。
 */
export interface SeasonCluster {
  key: string;
  label: string;
  /** クエリ判定パターン */
  re: RegExp;
  /** 需要のピーク月（1-12） */
  peakMonths: number[];
  /** ピークに評価を間に合わせるために記事を用意すべきリードタイム（月） */
  leadMonths: number;
}

/**
 * リカバリーウェアの季節プロファイル。
 * 商材を変える場合はここを書き換える。
 */
export const SEASON_CLUSTERS: SeasonCluster[] = [
  {
    key: "summer",
    label: "夏",
    re: /夏|暑い|涼し|クール|冷感|summer/i,
    peakMonths: [6, 7, 8, 9],
    leadMonths: 3,
  },
  {
    key: "winter",
    label: "冬",
    re: /冬|寒い|暖か|あったか|防寒|裏起毛|保温|winter/i,
    peakMonths: [11, 12, 1, 2],
    leadMonths: 3,
  },
];

/** 受け皿が十分かの判定に使う表示回数のしきい値 */
const COVERAGE_MIN_IMPRESSIONS = 50;

/** month(1-12) から次に cluster のピークが始まるまでの月数。ピーク中は0 */
export function monthsUntilPeak(cluster: SeasonCluster, month: number): number {
  if (cluster.peakMonths.includes(month)) return 0;
  let d = 1;
  while (d <= 12) {
    const m = ((month - 1 + d) % 12) + 1;
    if (cluster.peakMonths.includes(m)) return d;
    d++;
  }
  return 12;
}

/** ピーク中の場合、あと何ヶ月でピークが終わるか。ピーク外は null */
export function monthsLeftInPeak(cluster: SeasonCluster, month: number): number | null {
  if (!cluster.peakMonths.includes(month)) return null;
  let d = 0;
  while (d <= 12) {
    const m = ((month - 1 + d) % 12) + 1;
    if (!cluster.peakMonths.includes(m)) return d;
    d++;
  }
  return 12;
}

export interface SeasonCoverage {
  clicks: number;
  impressions: number;
  /** 全クリックに占める構成比 */
  share: number;
}

export interface SeasonAlert {
  level: "danger" | "warn" | "info";
  cluster: string;
  message: string;
}

/**
 * 季節クラスタの準備状況を判定する。
 *
 *  - ピークが近いのに受け皿が無い → 着手デッドライン（danger）
 *  - 現在ピーク中で依存度が高く、まもなく終わる → 端境期の落ち込み予告（warn）
 */
export function seasonAlerts(today: Date, coverage: Map<string, SeasonCoverage>): SeasonAlert[] {
  const month = today.getMonth() + 1;
  const alerts: SeasonAlert[] = [];

  for (const c of SEASON_CLUSTERS) {
    const cov = coverage.get(c.key) ?? { clicks: 0, impressions: 0, share: 0 };
    const hasCoverage = cov.impressions >= COVERAGE_MIN_IMPRESSIONS;
    const until = monthsUntilPeak(c, month);
    const left = monthsLeftInPeak(c, month);

    // ピークが近いのに受け皿が無い
    if (!hasCoverage && until > 0 && until <= c.leadMonths) {
      const peakStart = c.peakMonths[0];
      alerts.push({
        level: until <= 1 ? "danger" : "warn",
        cluster: c.label,
        message:
          `**${c.label}の受け皿が無い**（表示${cov.impressions}・クリック${cov.clicks}）。` +
          `ピークは${peakStart}月開始であと${until}ヶ月。評価がつくまで約${c.leadMonths}ヶ月かかるため、` +
          (until <= 1 ? "**着手期限を過ぎている**。今すぐ用意しないとこのシーズンは取れない。" : "今が着手のタイミング。"),
      });
    }

    // 現在の稼ぎ頭がまもなく端境期に入る
    if (left !== null && cov.share >= 0.2 && left <= 1) {
      alerts.push({
        level: "warn",
        cluster: c.label,
        message:
          `**${c.label}クラスタが全クリックの${(cov.share * 100).toFixed(0)}%を占めているが、` +
          `来月でピークが終わる。** 置き換える季節記事が無いと次期のレポートは数字が落ちる。`,
      });
    }
  }
  return alerts;
}

/**
 * 運用2年目以降、宣言した peakMonths が実データと合っているかを検証する。
 * 13ヶ月以上のデータが無い場合は null（検証不能）を返す。
 *
 * monthlyClicks: "YYYY-MM" → そのクラスタのクリック数
 */
export function verifyPeaks(
  cluster: SeasonCluster,
  monthlyClicks: Map<string, number>,
): { declared: number[]; actual: number[]; matches: boolean } | null {
  if (monthlyClicks.size < 13) return null;
  const byMonth = new Map<number, number>();
  for (const [ym, clicks] of monthlyClicks) {
    const m = Number(ym.slice(5, 7));
    byMonth.set(m, (byMonth.get(m) ?? 0) + clicks);
  }
  const total = [...byMonth.values()].reduce((s, v) => s + v, 0);
  if (total === 0) return null;
  // 上位（平均の1.5倍以上）の月を実際のピークとみなす
  const avg = total / byMonth.size;
  const actual = [...byMonth.entries()].filter(([, v]) => v >= avg * 1.5).map(([m]) => m).sort((a, b) => a - b);
  const declared = [...cluster.peakMonths].sort((a, b) => a - b);
  const matches = actual.length > 0 && actual.every((m) => declared.includes(m));
  return { declared, actual, matches };
}
