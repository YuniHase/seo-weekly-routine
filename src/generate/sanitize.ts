/**
 * 生成結果のアフィリエイトショートコード検証（プロンプト指示のすり抜け対策）。
 *
 * Claudeにカタログ外IDの創作を禁止していても稀にすり抜けるため、事後に機械的に除去する。
 * 許可 = サイト内で実在が確認できたカタログのコード ∪ 元記事に元から入っていたコード。
 * （元記事のコードはカタログ収集元が公開記事なので通常はカタログに含まれるが、念のため和集合にする）
 */
import type { AffiliateShortcode } from "../fetch/wp.ts";

export interface SanitizeResult {
  html: string;
  removed: string[];
}

export function sanitizeAffiliateCodes(
  html: string,
  catalog: AffiliateShortcode[] | undefined,
  originalHtml: string | undefined,
): SanitizeResult {
  // カタログ未提供時は判断材料が無いので何もしない（誤除去を避ける）
  if (!catalog?.length) return { html, removed: [] };
  const allowed = new Set(catalog.map((c) => c.code));
  for (const m of originalHtml?.match(/\[affi[^\]]*\]/g) ?? []) allowed.add(m);

  const removed: string[] = [];
  // 前後の空行ごと削る（段落だけが残って不自然な余白にならないように）
  const out = html.replace(/\s*\[affi[^\]]*\]/g, (match) => {
    const code = match.trim();
    if (allowed.has(code)) return match;
    removed.push(code);
    return "";
  });
  return { html: out, removed };
}
