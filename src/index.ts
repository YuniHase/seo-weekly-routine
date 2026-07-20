/**
 * エントリポイント（1回実行して終了する設計）。
 * GitHub Actions（.github/workflows/weekly.yml）が週1回 `npm start` で叩く。アプリ内cronは持たない。
 *
 * パイプライン（§0）:
 *   1. GSC取得（直近28日 + 前期比較）
 *   2. GA4取得（補助）
 *   3. WP記事取得（publish/draft/trash）→ 候補抽出（リライト / 新規）＋ 重複・却下スキップ
 *   4. スコア上位から MAX_DRAFTS_PER_RUN 件までドラフト生成
 *   5. WP下書き投稿（DRY_RUN=true ならログのみ）。提案メタは本文冒頭のHTMLコメントに記録
 *   6. 実行サマリーをログ出力
 *
 * 状態管理に外部DBは持たない。提案履歴・重複判定・却下判定は WordPress 自身のデータ
 * （publish=公開済み / draft=提案済み未レビュー / trash=却下済み）で行う。
 *
 * 現状はスキャフォールド。各ステップは後続の構築ステップで実装する。
 */
import { CONFIG } from "./config.ts";
import { log } from "./util/logger.ts";

async function main(): Promise<void> {
  const startedAt = Date.now();
  log.info("SEO週次ルーチン開始", {
    dryRun: CONFIG.run.dryRun,
    maxDrafts: CONFIG.run.maxDraftsPerRun,
    lookbackDays: CONFIG.run.lookbackDays,
  });

  // TODO(step4): const gsc = await fetchGscData();
  // TODO(step4): const ga4 = await fetchGa4Data();
  // TODO(step4): const wp = await fetchWpSnapshot(); // publish/draft/trash
  // TODO(step5): const candidates = buildCandidates({ ... });
  // TODO(step5): const fresh = filterAlreadyProposed(candidates, wp); // WPで重複・却下スキップ
  // TODO(step6): const drafts = await generateDrafts(topCandidates);
  // TODO(step7): await postDrafts(drafts);  // DRY_RUNならスキップ。提案メタはHTMLコメントで埋め込む

  log.warn("スキャフォールド段階のため、パイプライン本体は未実装です");

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  log.info("SEO週次ルーチン終了", { durationSec });
}

main().catch((e) => {
  log.error("ルーチンが異常終了しました", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
