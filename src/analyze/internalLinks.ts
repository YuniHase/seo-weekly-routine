/**
 * 内部リンク構造の分析（孤立記事の検出と、リンク元の提案）。
 *
 * 実測で41記事中24記事が「他記事から1本もリンクされていない」状態だった。
 * サイトマップ未送信と合わせて、Googleに発見されない直接の原因になっていた
 * （公開から140〜289日経ってクロールすらされていない記事が15本）。
 *
 * ここでは「どの記事からどの孤立記事へリンクすべきか」を関連度で提案する。
 * 実際にリンクを差し込むのはリライト生成時（＝人間がレビューする下書き）であり、
 * 公開中の記事を直接書き換えることはしない。
 *
 * 関連度は日本語を形態素解析せずに扱うため、文字バイグラムのDice係数で測る。
 * 形態素解析器を持ち込まずに「リカバリーウェア 洗濯」と「乾燥機にかけたら」の
 * ような近さを拾える。
 */

export interface ArticleNode {
  path: string;
  title: string;
  outbound: string[];
}

export interface OrphanInfo {
  path: string;
  title: string;
  /** 被リンク数（0が孤立） */
  inbound: number;
}

/** 文字バイグラム集合（日本語の簡易な類似度用） */
function bigrams(s: string): Set<string> {
  const t = s
    .toLowerCase()
    .replace(/[【】\[\]（）()｜|・,、。．.!！?？:：/／\-—–_"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out = new Set<string>();
  for (const word of t.split(" ")) {
    for (let i = 0; i < word.length - 1; i++) out.add(word.slice(i, i + 2));
  }
  return out;
}

/** Dice係数（0〜1） */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** 被リンク数を数える */
export function inboundCounts(nodes: ArticleNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.path, 0);
  for (const n of nodes) {
    for (const t of n.outbound) {
      if (counts.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return counts;
}

/** 他記事から1本もリンクされていない記事 */
export function findOrphans(nodes: ArticleNode[]): OrphanInfo[] {
  const counts = inboundCounts(nodes);
  return nodes
    .filter((n) => (counts.get(n.path) ?? 0) === 0)
    .map((n) => ({ path: n.path, title: n.title, inbound: 0 }));
}

export interface LinkSuggestion {
  path: string;
  title: string;
  url: string;
  /** 関連度（0〜1） */
  score: number;
}

/**
 * ある記事（リンク元）から張るべき孤立記事を、関連度の高い順に返す。
 *
 * @param sourceText リンク元のタイトルと主要クエリを連結したもの
 * @param orphans    孤立記事
 * @param alreadyLinked リンク元がすでに張っているリンク先（重複提案を避ける）
 * @param minScore   これ未満は関連が薄いとみなし提案しない
 */
export function suggestOrphanLinks(
  sourceText: string,
  orphans: OrphanInfo[],
  alreadyLinked: string[],
  siteBaseUrl: string,
  limit = 5,
  minScore = 0.08,
): LinkSuggestion[] {
  const src = bigrams(sourceText);
  const linked = new Set(alreadyLinked);
  const base = siteBaseUrl.replace(/\/+$/, "");
  return orphans
    .filter((o) => !linked.has(o.path))
    .map((o) => ({
      path: o.path,
      title: o.title,
      url: `${base}${o.path}/`,
      score: dice(src, bigrams(o.title)),
    }))
    .filter((o) => o.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * 孤立記事ごとに「リンク元としてふさわしい既存記事」を提案する（レポート用）。
 * 候補は被リンクのある＝インデックスされている可能性が高い記事に限る。
 */
export function suggestSourcesForOrphans(
  nodes: ArticleNode[],
  orphans: OrphanInfo[],
  limit = 2,
  /** 検索で表示実績のあるパス（＝インデックス済みが確実）。渡せばリンク元をここに限定する */
  indexedPaths?: Set<string>,
): Array<{ orphan: OrphanInfo; sources: Array<{ path: string; title: string; score: number }> }> {
  const counts = inboundCounts(nodes);
  // リンク元は「Googleが実際に見に来ている記事」でなければ発見経路にならない。
  // 表示実績が分かる場合はそれを使い、無ければ被リンクがある記事で代用する。
  const candidates = indexedPaths
    ? nodes.filter((n) => indexedPaths.has(n.path))
    : nodes.filter((n) => (counts.get(n.path) ?? 0) > 0);
  return orphans.map((o) => {
    const ob = bigrams(o.title);
    const sources = candidates
      .filter((c) => c.path !== o.path && !c.outbound.includes(o.path))
      .map((c) => ({ path: c.path, title: c.title, score: dice(ob, bigrams(c.title)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { orphan: o, sources };
  });
}
