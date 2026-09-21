/**
 * FAQ セクションを Cocoon の FAQ ブロック（cocoon-blocks/faq）に変換する。
 *
 * サイトの既存記事は Cocoon の FAQ ブロックで Q&A を書いており（26箇所で使用）、
 * 生成物だけ素の見出し+段落だと見た目が揃わない。
 *
 * ブロック記法は属性JSON・クラス名・入れ子が固定で、モデルに書かせると崩れやすい。
 * そのため生成時は素直な `<h3>Q. 質問</h3> 回答` を出させ、ここで機械的に変換する。
 *
 * 変換対象は「Q.」「Q:」等で始まる h3 とその直後の回答。該当が無ければ何もしない。
 */

/** Cocoon FAQブロック1件分のマークアップを組み立てる */
function faqBlock(question: string, answerHtml: string): string {
  const q = question.trim();
  const inner = answerHtml.trim();
  // 回答は paragraph ブロックとして内包する（既存記事と同じ構造）
  const body = /^<(p|ul|ol)\b/i.test(inner)
    ? inner
    : `<!-- wp:paragraph -->\n<p>${inner}</p>\n<!-- /wp:paragraph -->`;
  return (
    `<!-- wp:cocoon-blocks/faq ${JSON.stringify({ question: q })} -->\n` +
    `<div class="wp-block-cocoon-blocks-faq faq-wrap blank-box block-box not-nested-style cocoon-block-faq">` +
    `<dl class="faq">` +
    `<dt class="faq-question faq-item"><div class="faq-question-label faq-item-label">Q</div>` +
    `<div class="faq-question-content faq-item-content">${q}</div></dt>` +
    `<dd class="faq-answer faq-item"><div class="faq-answer-label faq-item-label">A</div>` +
    `<div class="faq-answer-content faq-item-content">${body}</div></dd>` +
    `</dl></div>\n` +
    `<!-- /wp:cocoon-blocks/faq -->`
  );
}

/** 先頭の「Q.」「Q:」「Q1.」等のラベルを落とす */
function stripQLabel(s: string): string {
  return s.replace(/^\s*Q\s*[0-9]*\s*[.:．：、]?\s*/i, "").trim();
}
/** 先頭の「A.」「A:」等のラベルを落とす */
function stripALabel(s: string): string {
  return s.replace(/^\s*A\s*[0-9]*\s*[.:．：、]?\s*/i, "").trim();
}

/**
 * `<h3>Q. …</h3>` + 直後の回答 を Cocoon FAQブロックに変換する。
 * 変換件数も返すので、呼び出し側でログに出せる。
 */
export function toCocoonFaqBlocks(html: string): { html: string; converted: number } {
  // h3(Q...) から次の h2/h3 手前までを1件とみなす
  const re = /<h3[^>]*>\s*(Q\s*[0-9]*\s*[.:．：、][\s\S]*?)<\/h3>([\s\S]*?)(?=<h[23][^>]*>|$)/gi;
  let converted = 0;
  const out = html.replace(re, (_m, qRaw: string, aRaw: string) => {
    const question = stripQLabel(qRaw.replace(/<[^>]+>/g, ""));
    let answer = aRaw.trim();
    if (!question || !answer) return _m;
    // 回答が素のテキスト（<p>で包まれていない）の場合に備えてラベルだけ外す
    const isTagWrapped = /^<(p|ul|ol)\b/i.test(answer);
    answer = isTagWrapped
      ? answer.replace(/^(<p[^>]*>)\s*A\s*[0-9]*\s*[.:．：、]?\s*/i, "$1")
      : stripALabel(answer);
    converted++;
    return faqBlock(question, answer);
  });
  return { html: out, converted };
}
