/**
 * 検索エンジン別の自然検索流入（GA4 由来）。
 *
 * 候補抽出・順位・SEOダイジェストは Google Search Console のデータだけで動いている。
 * ところが実測（2026-10-10〜11-06）では、自然検索のセッションは Bing系 466 / Google 290 /
 * Yahoo! 98 で、Bing のほうが多かった。しかも収益の82%を占める /bakune-review は検索流入の
 * 96%が Bing系で、Google からは28日で3セッションしかない。GSC だけを見ていると、この記事を
 * 「Googleで11位の惜しい記事」と読んでリライトを提案してしまう（11/2 の下書き632）。
 *
 * Bing系 = Bing・DuckDuckGo・Ecosia（いずれも Bing の検索結果を使う）。
 * Yahoo! JAPAN の検索結果は Google 製だが、クリックは GSC に出ないので別に数える。
 */

export type Engine = "bing" | "google" | "yahoo" | "other";
export type EngineCounts = Record<Engine, number>;

export interface OrganicByEngine {
  /** 着地ページ（末尾スラッシュなし）→ エンジン別セッション */
  current: Map<string, EngineCounts>;
  previous: Map<string, EngineCounts>;
}

export const ENGINE_LABEL: Record<Engine, string> = {
  bing: "Bing系",
  google: "Google",
  yahoo: "Yahoo!",
  other: "その他",
};

export const emptyCounts = (): EngineCounts => ({ bing: 0, google: 0, yahoo: 0, other: 0 });

/** GA4 の sessionSource を検索エンジンに分類する */
export function engineOf(source: string): Engine {
  const s = source.toLowerCase();
  if (s.includes("bing") || s.includes("duckduckgo") || s.includes("ecosia")) return "bing";
  if (s.includes("google")) return "google";
  if (s.includes("yahoo")) return "yahoo";
  return "other";
}

export const totalOf = (c: EngineCounts): number => c.bing + c.google + c.yahoo + c.other;

export function sumAll(m: Map<string, EngineCounts>): EngineCounts {
  const out = emptyCounts();
  for (const c of m.values()) for (const k of Object.keys(out) as Engine[]) out[k] += c[k];
  return out;
}

/**
 * Google 以外に流入を頼っている記事なら、その割合と注意書きを返す。
 * GSC の数字を根拠にした提案を、この記事に当てはめてよいかを人間が判断できるようにする。
 *
 * @param minSessions これ未満の流入は判断材料にならないので扱わない
 */
export function bingDependence(
  organic: OrganicByEngine | undefined,
  path: string,
  minSessions = 10,
  minShare = 0.5,
): { share: number; bing: number; google: number; note: string } | null {
  const c = organic?.current.get(path.replace(/\/+$/, "") || "/");
  if (!c) return null;
  const total = totalOf(c);
  if (total < minSessions || c.bing / total < minShare) return null;
  const share = c.bing / total;
  return {
    share,
    bing: c.bing,
    google: c.google,
    note: `検索流入の${Math.round(share * 100)}%がBing系（${c.bing}セッション。Googleは${c.google}）。この提案はGoogleのデータだけで作っているので、Bingからの流入と導線を崩さないか確認すること`,
  };
}
