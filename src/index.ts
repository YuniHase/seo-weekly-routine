/**
 * エントリポイント（1回実行して終了する設計）。
 * GitHub Actions（.github/workflows/weekly.yml）が週1回 `npm start` で叩く。アプリ内cronは持たない。
 *
 * パイプライン（§0）:
 *   1. GSC取得（直近28日 + 前期比較）
 *   2. GA4取得（補助）
 *   3. WP記事取得（publish/draft/trash）→ 候補抽出（リライト / 新規）＋ 重複・却下スキップ
 *   4. スコア上位から MAX_DRAFTS_PER_RUN 件を選定
 *   5. Claude（Batch API・50%オフ）でドラフト生成
 *   6. WP下書き投稿（新規POST。元記事は変更しない）。DRY_RUN=true なら生成・投稿せず対象一覧のみ
 *   7. 実行サマリーをログ出力
 *
 * 状態管理に外部DBは持たない。提案履歴・重複・却下判定は WordPress 自身のデータで行う。
 * タイトル選定と公開は人間が手動（WP管理画面の下書きをレビュー）。
 */
import { CONFIG } from "./config.ts";
import { log } from "./util/logger.ts";
import { fetchGscData } from "./fetch/gsc.ts";
import { fetchGa4Data } from "./fetch/ga4.ts";
import { fetchWpSnapshot, fetchPostContent, createDraft } from "./fetch/wp.ts";
import { buildCandidates, sensitivity } from "./analyze/pipeline.ts";
import { generateDraftsBatch, type GenItem } from "./generate/batch.ts";
import { generateDraftSync, type GeneratedDraft } from "./generate/draft.ts";
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
    useBatch: CONFIG.batch.useBatch,
    maxDrafts: CONFIG.run.maxDraftsPerRun,
    lookbackDays: CONFIG.run.lookbackDays,
  });

  const [gsc, ga4, wp] = await Promise.all([fetchGscData(), fetchGa4Data(), fetchWpSnapshot()]);
  log.info("WP記事数", { publish: wp.publish.length, draft: wp.draft.length, trash: wp.trash.length });

  const input: AnalyzeInput = { gscCurrent: gsc.current, gscPrevious: gsc.previous, ga4, wp };
  const { counts, allSorted, dedup, n2Excluded } = buildCandidates(input);

  console.log("\n========== 候補抽出サマリー ==========");
  console.log(`分析期間: current ${gsc.currentPeriod.startDate}〜${gsc.currentPeriod.endDate} / previous ${gsc.previousPeriod.startDate}〜${gsc.previousPeriod.endDate}`);
  console.log(`データ規模: GSC current=${gsc.current.length}行 previous=${gsc.previous.length}行 / GA4 ${ga4.length}行 / WP publish=${wp.publish.length} draft=${wp.draft.length} trash=${wp.trash.length}`);
  console.log("\n■ 各ルールの閾値通過件数（重複カウント可・dedup前）");
  console.log(`  リライト: R1=${counts.R1}  R2=${counts.R2}  R3=${counts.R3}`);
  console.log(`  新規:     N1=${counts.N1}  N2=${counts.N2}（N2は要Claude判断）`);
  if (n2Excluded.length > 0) {
    console.log(`  ※ N2追加フィルタ(Option B)で除外: ${n2Excluded.length}件（カニバリ回避）`);
    for (const x of n2Excluded) {
      const basis = x.basis === "per-query" ? "クエリ単位順位" : "記事全体順位";
      console.log(`     - "${x.query}" Imp${x.impressions} … ${x.publishedUrl} が ${basis} pos${x.publishedPosition.toFixed(1)}`);
    }
  }

  console.log(`\n■ 候補（dedup前 ${allSorted.length}件 → WP照合後 kept ${dedup.kept.length}件 / skip ${dedup.skipped.length}件）`);
  const selected = dedup.kept.slice(0, CONFIG.run.maxDraftsPerRun);
  if (dedup.kept.length === 0) {
    console.log("  採用候補は0件。下の感度分析を参照。");
  } else {
    console.log(`  【今週の生成対象（上位${CONFIG.run.maxDraftsPerRun}件）】`);
    selected.forEach((c, i) => console.log(line(c, i)));
    if (dedup.kept.length > selected.length) {
      console.log(`  （対象外の残り候補: ${dedup.kept.length - selected.length}件）`);
    }
  }
  if (dedup.skipped.length > 0) {
    console.log("\n  【スキップ（重複/却下）】");
    dedup.skipped.forEach(({ candidate, reason }) => console.log(`   - [${candidate.rule}] ${candidate.targetUrl ?? candidate.queries[0]} … ${reason}`));
  }

  console.log("\n■ 閾値感度分析");
  for (const row of sensitivity(input)) {
    console.log(`  ${row.label}:  ${row.variants.map((v) => `${v.value}→${v.count}件`).join("  ")}`);
  }

  // ── DRY_RUN: ここで停止（生成・投稿しない） ──
  if (CONFIG.run.dryRun) {
    console.log(`\n[DRY_RUN] 生成・投稿はスキップ。上記 ${selected.length} 件が今週の生成対象です。`);
    console.log("========== DRY_RUN 終了 ==========\n");
    log.info("SEO週次ルーチン終了（DRY_RUN）", { durationSec: Math.round((Date.now() - startedAt) / 1000), wouldCreate: selected.length });
    return;
  }

  // ── 本番: 生成 → 新規下書き投稿 ──
  if (selected.length === 0) {
    log.info("生成対象なし。終了。");
    return;
  }

  // リライトは元記事本文を取得（元記事はGETのみ・変更しない）
  const items: GenItem[] = [];
  for (const c of selected) {
    if (c.type === "rewrite") {
      if (!c.wpPostId) { log.warn("wpPostId未解決のためスキップ", { url: c.targetUrl }); continue; }
      const orig = await fetchPostContent(c.wpPostId);
      items.push({ candidate: c, ctx: { originalTitle: orig.title, originalHtml: orig.contentHtml } });
    } else {
      items.push({ candidate: c, ctx: { internalLinkTitles: wp.publish.map((p) => p.title) } });
    }
  }

  // 生成（本番=Batch / USE_BATCH=false=同期）
  let drafts = new Map<number, GeneratedDraft>();
  if (CONFIG.batch.useBatch) {
    drafts = await generateDraftsBatch(items);
  } else {
    for (let i = 0; i < items.length; i++) {
      try { drafts.set(i, await generateDraftSync(items[i].candidate, items[i].ctx)); }
      catch (e) { log.error(`同期生成失敗 idx=${i}`, e instanceof Error ? e.message : String(e)); }
    }
  }

  // 投稿（新規下書きPOST。元記事は上書きしない）
  let created = 0, failed = 0;
  let inTok = 0, outTok = 0;
  for (let i = 0; i < items.length; i++) {
    const d = drafts.get(i);
    const c = items[i].candidate;
    if (!d) { failed++; log.warn("生成結果なし（スキップ）", { url: c.targetUrl ?? c.queries[0] }); continue; }
    inTok += d.usage.inputTokens; outTok += d.usage.outputTokens;
    try {
      const res = await createDraft({ title: d.title, contentHtml: d.contentHtml });
      created++;
      log.info("下書き投稿", { id: res.id, rule: c.rule, title: d.title, editLink: res.editLink });
    } catch (e) {
      failed++;
      log.error("下書き投稿失敗", { url: c.targetUrl ?? c.queries[0], error: e instanceof Error ? e.message : String(e) });
    }
  }

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  log.info("実行サマリー", {
    selected: selected.length, created, failed,
    tokens: { input: inTok, output: outTok },
    durationSec,
  });
  console.log(`\n========== 完了: 下書き ${created}件作成 / 失敗 ${failed}件（人間が管理画面でレビュー→タイトル選定→公開） ==========\n`);
}

main().catch((e) => {
  log.error("ルーチンが異常終了しました", e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});
