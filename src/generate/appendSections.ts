/**
 * 部分追記（既存本文を一切書き換えず、セクションだけ足す）。
 *
 * 全文リライトは、稼いでいる記事には使えない。
 * 例: /bakune-review はアフィクリックがサイト全体の40%を占めるが、検索流入は
 * 251表示・8クリックしかない。収益のほとんどは内部リンク経由なので、本文の
 * 説得力や導線が少しでも劣化すると、得られる検索クリック数本に対して
 * 失うものが大きすぎる。
 *
 * そこで **モデルには元記事を出力させない**。追加するセクションだけを書かせ、
 * 差し込みはコード側で行う。これにより元本文の保持が構造的に保証される
 * （モデルが書き換えようとしても、書き換える対象が手元に無い）。
 */
import type { AffiliateShortcode } from "../fetch/wp.ts";

export interface NewSection {
  /** 挿入位置: 0始まりのh2番号の「後ろ」。null なら末尾 */
  afterH2Index: number | null;
  heading: string;
  bodyHtml: string;
}

/** 元記事のh2見出しを順に抜き出す（挿入位置の指定に使う） */
export function listH2(html: string): string[] {
  return [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}

export function buildAppendPrompt(
  title: string,
  originalHtml: string,
  targetQueries: Array<{ query: string; impressions: number; position: number; clicks: number }>,
  catalog: AffiliateShortcode[],
): string {
  const h2s = listH2(originalHtml).map((h, i) => `  ${i}: ${h}`).join("\n");
  const qs = targetQueries
    .map((q) => `  - 「${q.query}」 表示${q.impressions} クリック${q.clicks} 現在${q.position.toFixed(1)}位`)
    .join("\n");
  const codes = catalog.map((s) => `  - ${s.code} → ${s.product ?? "（商品不明）"}`).join("\n");

  return `既存記事に「セクションを追記」してください。**既存の本文は一切変更しません。**

## 記事タイトル
${title}

## 既存記事の本文（読むだけ。書き換えない・出力しない）
${originalHtml}

## 既存のh2見出し（挿入位置の指定に使う）
${h2s}

## 取りこぼしているクエリ（これを取りにいく）
${qs}

## 指示
- 上記クエリの検索意図に答える**新しいセクションを1〜3個**書く。既存の本文には触れない。
- **見出しに検索クエリの文字列をそのまま入れない。** 読者が自然に読める日本語の見出しにする。
  悪い例:「「バクネ 感想」「バク寝 リラク」で検索する人へ」
  良い例:「実際に半年使って分かった、向いている人・向いていない人」
  クエリは見出しではなく本文の内容で満たす。表記ゆれやタイプミスのクエリは無理に狙わない。
- 既存記事に**すでに書かれている内容の繰り返しにしない**。書かれていない切り口だけを足す。
- **事実・数値・商品スペックを創作しない。** 元記事に無い新しい事実主張はしない。
  「〜と感じる人もいます」「〜という声もあります」のように、一般的に言える範囲で書く。
- 具体的な価格金額は書かない。価格に触れるなら「最新価格は公式サイト・Amazon・楽天でご確認ください」。
- 薬機法・景表法を厳守。断定的な効能表現は禁止。
- ネガティブな検索意図（「評判悪い」「効果ない」等）には、**否定も誇張もせず正直に答える**。
  合わない人の条件を具体的に書くほうが、読者の信頼を得られる。
- 必要ならアフィリエイトのショートコードを**1本まで**入れてよい（無くてもよい）。下記の実在コードのみ:
${codes || "  （なし）"}

## 出力形式
下記の区切り行を使い、セクションごとに繰り返してください。**JSONにしないこと。**
ANCHOR は挿入したい位置の直前にあるh2の番号（上記リストの数字）。末尾に置くなら end。
HTMLはエスケープせずそのまま書いてください。

===SECTION===
ANCHOR: 3
HEADING: 追加するh2見出しのテキスト
BODY:
<p>本文HTML（h3や箇条書きを使ってよい。h2見出しはHEADINGとして出すのでBODYには含めない）</p>
===SECTION===
ANCHOR: end
HEADING: ...
BODY:
...
===END===`;
}

/** 生成結果からセクションを取り出す */
export function parseSections(text: string): NewSection[] {
  const body = /^===END===\s*$/m.test(text) ? text : text + "\n===END===\n";
  const chunks = body.split(/^===SECTION===\s*$/m).slice(1);
  const out: NewSection[] = [];
  for (const raw of chunks) {
    const chunk = raw.split(/^===END===\s*$/m)[0];
    const anchorRaw = /^ANCHOR:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "end";
    const heading = /^HEADING:\s*(.+)$/m.exec(chunk)?.[1]?.trim() ?? "";
    const bodyMatch = /^BODY:\s*$([\s\S]*)/m.exec(chunk);
    const bodyHtml = (bodyMatch?.[1] ?? "").trim();
    if (!heading || !bodyHtml) continue;
    const n = Number(anchorRaw);
    out.push({ afterH2Index: Number.isFinite(n) ? n : null, heading, bodyHtml });
  }
  return out;
}

/**
 * 元記事にセクションを差し込む。元のHTMLは切り貼りするだけで書き換えない。
 * 挿入位置は「指定したh2が属するセクションの終わり（＝次のh2の直前）」。
 */
export function spliceSections(originalHtml: string, sections: NewSection[]): string {
  // h2の開始位置を集める。Gutenbergのブロックコメントも巻き込まないよう見出しコメントから探す
  const starts: number[] = [];
  const re = /(?:<!--\s*wp:heading[^>]*-->\s*)?<h2[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(originalHtml))) starts.push(m.index);

  const block = (s: NewSection) =>
    `\n<!-- wp:heading -->\n<h2 class="wp-block-heading">${s.heading}</h2>\n<!-- /wp:heading -->\n${s.bodyHtml}\n`;

  // 挿入位置（文字オフセット）を決める。後ろから入れてオフセットのズレを防ぐ
  const inserts = sections.map((s) => {
    const i = s.afterH2Index;
    // 指定h2の「次のh2の直前」に入れる。最後のh2または未指定なら末尾
    const at = i !== null && i >= 0 && i + 1 < starts.length ? starts[i + 1] : originalHtml.length;
    return { at, html: block(s) };
  });
  inserts.sort((a, b) => b.at - a.at);

  let out = originalHtml;
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.html + out.slice(ins.at);
  return out;
}

/**
 * 元記事が壊れていないことの検証。
 * 差し込みはコード側で行うので本来壊れないが、事故検知のため明示的に確認する。
 */
export function verifyOriginalPreserved(originalHtml: string, result: string): { ok: boolean; reason?: string } {
  const strip = (h: string) => h.replace(/\s+/g, "");
  // 元記事の断片（h2で区切った各ブロック）がすべて結果に残っているか
  const parts = originalHtml.split(/(?=<h2)/i).map(strip).filter((p) => p.length > 40);
  const r = strip(result);
  for (const p of parts) {
    if (!r.includes(p)) return { ok: false, reason: `元記事の一部が失われています: ${p.slice(0, 60)}...` };
  }
  return { ok: true };
}
