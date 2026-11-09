/**
 * 週次レポート: 検索エンジン別の流入（GA4）。
 *
 * レポートの他の節（順位・SEOダイジェスト・検索意図）と候補抽出は、すべて Google Search Console の
 * データで動いている。Bing系と Yahoo! の検索流入はそこに出ないので、この節で補う。
 * 背景は src/analyze/searchEngines.ts を参照。
 */
import { ENGINE_LABEL, sumAll, totalOf, bingDependence, type Engine, type OrganicByEngine } from "../analyze/searchEngines.ts";
import type { AffiliateClicks } from "../analyze/types.ts";

const ENGINES: Engine[] = ["bing", "google", "yahoo", "other"];
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "-");
const delta = (cur: number, prev: number) => (prev > 0 ? `${cur >= prev ? "+" : ""}${Math.round(((cur - prev) / prev) * 100)}%` : "-");

export function searchEngineSection(organic: OrganicByEngine, affiliate: Map<string, AffiliateClicks>): string {
  if (organic.current.size === 0) return "";
  const cur = sumAll(organic.current);
  const prev = sumAll(organic.previous);
  const curTotal = totalOf(cur);

  // Google 以外からの流入が多い記事（Bing系が10セッション以上）。
  // GA4 が着地ページを取れなかったセッション（"(not set)" など）は記事ではないので除く
  const totalAff = [...affiliate.values()].reduce((s, a) => s + a.total, 0);
  const pages = [...organic.current.entries()]
    .filter(([p, c]) => !p.startsWith("(") && c.bing >= 10)
    .sort((a, b) => b[1].bing - a[1].bing)
    .slice(0, 8);

  // 収益の大部分を、GSC に映らない流入で稼いでいる記事
  const warnings = pages
    .map(([p, c]) => ({ p, c, aff: affiliate.get(p)?.total ?? 0 }))
    .filter(({ p, aff }) => totalAff > 0 && aff / totalAff >= 0.2 && (bingDependence(organic, p, 10, 0.8) !== null))
    .map(({ p, c, aff }) =>
      `⚠️ **\`${p}\` はアフィクリックの${pct(aff, totalAff)}を占め、検索流入の${pct(c.bing, totalOf(c))}がBing系。** ` +
      "Google の順位を根拠にしたリライト提案は、この流入を見ていない。提案が来ても、Bing からの流入と導線を崩さないことを優先する。",
    );

  return [
    "## 🔎 検索エンジン別の流入（GA4）",
    "> この節以外の順位・ダイジェスト・検索意図と、リライト候補の抽出は **Google Search Console のデータだけ**で作っている。",
    "> Bing系と Yahoo! の検索流入はそこに出ないので、ここで補う。",
    "> Bing系 = Bing・DuckDuckGo・Ecosia（Bing の検索結果を使う）。Yahoo! JAPAN の検索結果は Google 製だが、クリックは GSC に出ない。",
    "",
    "| 検索エンジン | セッション | 前28日 | 前期比 | 構成比 |",
    "|---|---|---|---|---|",
    ...ENGINES.map((e) => `| ${ENGINE_LABEL[e]} | ${cur[e]} | ${prev[e]} | ${delta(cur[e], prev[e])} | ${pct(cur[e], curTotal)} |`),
    `| **合計** | **${curTotal}** | ${totalOf(prev)} | ${delta(curTotal, totalOf(prev))} | |`,
    "",
    ...(pages.length
      ? [
          "### Bing系からの流入が多い記事",
          "| 記事 | Bing系 | 前28日 | Google | Yahoo! | Bing系の割合 | アフィクリック |",
          "|---|---|---|---|---|---|---|",
          ...pages.map(([p, c]) => {
            const before = organic.previous.get(p)?.bing ?? 0;
            return `| \`${p}\` | **${c.bing}** | ${before} | ${c.google} | ${c.yahoo} | ${pct(c.bing, totalOf(c))} | ${affiliate.get(p)?.total ?? 0} |`;
          }),
          "",
        ]
      : []),
    ...(warnings.length ? [...warnings, ""] : []),
  ].join("\n");
}
