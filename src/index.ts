/**
 * エントリポイント（1回実行して終了する設計）。
 * GitHub Actions（.github/workflows/weekly.yml）が週1回 `npm start` で叩く。アプリ内cronは持たない。
 *
 * パイプライン（§0）:
 *   1. GSC取得（直近28日 + 前期比較）
 *   2. GA4取得（補助）
 *   3. WP記事取得（publish/draft/trash）→ 候補抽出（リライト / 新規）＋ 重複・却下スキップ
 *   4. スコア上位から MAX_DRAFTS_PER_RUN 件までドラフト生成 … step6（未実装）
 *   5. WP下書き投稿（DRY_RUN=true ならログのみ） … step7（未実装）
 *
 * 状態管理に外部DBは持たない。提案履歴・重複・却下判定は WordPress 自身のデータで行う。
 *
 * 現在 step5 まで実装: 候補抽出＋重複スキップ＋DRY_RUNでの候補リスト/閾値感度の出力。
 */
import { CONFIG } from "./config.ts";
import { log } from "./util/logger.ts";
import { fetchGscData } from "./fetch/gsc.ts";
import { fetchGa4Data } from "./fetch/ga4.ts";
import { fetchWpSnapshot } from "./fetch/wp.ts";
import { buildCandidates, sensitivity } from "./analyze/pipeline.ts";
import type { AnalyzeInput, Candidate } from "./analyze/types.ts";

function line(c: Candidate, i: number): string {
  const m = c.metrics;
  const met = [
    m.position !== undefined ? `pos${m.position.toFixed(1)}` : null,
    m.ctr !== undefined ? `CTR${(m.ctr * 100).toFixed(1)}%` : null,
    m.impressions !== undefined ? `Imp${m.impressions}` : null,
    m.clicks !== undefined ? `clk${m.clicks}` : null,
  ].filter(Boolean).join(" ");
  const tgt = c.targetUrl ?? "(新規)";
  return `  ${String(i + 1).padStart(2)}. [${c.rule}] score=${c.score}  ${tgt}\n      ${met}  クエリ: ${c.queries.map((q) => `"${q}"`).join(", ")}`;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  log.info("SEO週次ルーチン開始", {
    dryRun: CONFIG.run.dryRun,
    maxDrafts: CONFIG.run.maxDraftsPerRun,
    lookbackDays: CONFIG.run.lookbackDays,
  });

  const [gsc, ga4, wp] = await Promise.all([fetchGscData(), fetchGa4Data(), fetchWpSnapshot()]);
  log.info("WP記事数", { publish: wp.publish.length, draft: wp.draft.length, trash: wp.trash.length });

  const input: AnalyzeInput = { gscCurrent: gsc.current, gscPrevious: gsc.previous, ga4, wp };
  const { counts, allSorted, dedup } = buildCandidates(input);

  console.log("\n========== 候補抽出サマリー（DRY_RUN レビュー用） ==========");
  console.log(`分析期間: current ${gsc.currentPeriod.startDate}〜${gsc.currentPeriod.endDate} / previous ${gsc.previousPeriod.startDate}〜${gsc.previousPeriod.endDate}`);
  console.log(`データ規模: GSC current=${gsc.current.length}行 previous=${gsc.previous.length}行 / GA4 ${ga4.length}行 / WP publish=${wp.publish.length} draft=${wp.draft.length} trash=${wp.trash.length}`);

  console.log("\n■ 各ルールの閾値通過件数（重複カウント可・dedup前）");
  console.log(`  リライト: R1=${counts.R1}  R2=${counts.R2}  R3=${counts.R3}`);
  console.log(`  新規:     N1=${counts.N1}  N2=${counts.N2}（N2は要Claude判断）`);

  console.log(`\n■ 候補（dedup前 ${allSorted.length}件 → WP照合後 kept ${dedup.kept.length}件 / skip ${dedup.skipped.length}件）`);
  if (dedup.kept.length === 0) {
    console.log("  ⚠ 採用候補は0件でした（下の感度分析を参照）");
  } else {
    console.log("  【採用候補（スコア降順）】");
    dedup.kept.forEach((c, i) => console.log(line(c, i)));
    console.log(`  ※ 実運用では上位 ${CONFIG.run.maxDraftsPerRun} 件（MAX_DRAFTS_PER_RUN）のみドラフト生成対象`);
  }
  if (dedup.skipped.length > 0) {
    console.log("\n  【スキップ（重複/却下）】");
    dedup.skipped.forEach(({ candidate, reason }) => console.log(`   - [${candidate.rule}] ${candidate.targetUrl ?? candidate.queries[0]} … ${reason}`));
  }

  console.log("\n■ 閾値感度分析（閾値をこう緩めると何件になりそうか）");
  for (const row of sensitivity(input)) {
    console.log(`  ${row.label}:  ${row.variants.map((v) => `${v.value}→${v.count}件`).join("  ")}`);
  }

  console.log("\n========== ここで停止（step5レビュー）。ドラフト生成/投稿は未実行 ==========\n");

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  log.info("SEO週次ルーチン終了（step5まで）", { durationSec });
}

main().catch((e) => {
  log.error("ルーチンが異常終了しました", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
