# seo-weekly-routine

recovery-wear-guide.com の週次SEOルーチン。週1回自動実行し、Search Console / GA4 のデータから
「リライトすべき既存記事」「新規に書くべき記事」を判定 → Claude API（Batch）でドラフト生成 →
WordPress に**下書き（status=draft）**として自動投稿する。

**人間の作業は週1回**：WP管理画面の下書き一覧を見て、**タイトルを選定し、編集して公開 or 破棄**する。
（タイトル選定と公開は完全に人間の手動。ルーチンは下書きを用意するところまで）

## 技術スタック

- Node.js 20 + TypeScript（ESM / `tsx` 実行）
- googleapis（Search Console API / GA4 Data API、サービスアカウントJWT認証）
- WP REST API + アプリケーションパスワード（Basic認証）
- Claude API（`@anthropic-ai/sdk`、Batch API で50%オフ）
- **外部データベースなし**。提案履歴・重複判定・却下判定は WordPress 自身の記事ステータスで管理
- GitHub Actions（`on: schedule` cron）で週1回 `npm start`（アプリ内cronは持たない・コスト0円運用）

## 稼働フロー

```
[GitHub Actions cron 日曜22:00 UTC = 月曜07:00 JST]
  → GSC(直近28日+前期) / GA4(直近28日) / WP(publish,draft,trash) 取得
  → 候補抽出(R1/R2/R3=リライト, N1/N2=新規) + スコアリング + GA4重み
  → WPで重複・却下スキップ(既提案/却下と照合)
  → 上位 MAX_DRAFTS_PER_RUN 件を Claude(Batch) でドラフト生成
  → 新規下書きとしてWP投稿(元記事は変更しない) / DRY_RUN=true なら一覧ログのみ
  → 実行サマリーをログ出力
[人間] 月曜朝: 下書きをレビュー → タイトル選定 → 公開 or 破棄
```

## 稼働環境と運用前提

- **スケジューラ**: GitHub Actions。`.github/workflows/weekly.yml` が日曜22:00 UTC（=月曜07:00 JST）に自動実行。`workflow_dispatch` で手動実行も可能。ランナーは `ubuntu-latest`（Linux／無料枠節約）。プライベートリポジトリの無料枠（月2,000分）に対し本ルーチンは月10〜20分程度で十分収まる。支出上限$0のままなら超過時も課金でなくジョブ停止。
- **⚠️ Xserver REST API 制限は「常時OFF」運用が前提（案1・オーナー了承済み）**: GitHub Actionsは実行のたびに海外IPが変わり固定IP許可が使えないため、Xserverの「国外アクセス制限 → REST API アクセス制限」を**OFFのまま**運用する。cronは月曜7時に**無人起動**するので、その時刻に制限がOFFである必要がある。
  - 書き込み（投稿/編集）はアプリケーションパスワード認証必須のため、制限OFFでも認証なしでは書き込めない（検証済み）。ブルートフォース対策・ユーザー名秘匿は Wordfence でON維持。防御層が一枚減るのは事実だが、致命的ではないとの判断（リスク受容済み）。
- **状態管理（外部DBなし）**: 「何を提案し、何を採用/却下したか」は WordPress 自身が持つ。投稿前に WP REST API で記事ステータスを読んで判定：
  - `publish`（公開済み）: リライト対象の母集団 / 新規テーマの受け皿有無の判定
  - `draft`（下書き＝提案済み未レビュー）: **既に提案済み → スキップ**
  - `trash`（ゴミ箱＝却下済み）: **却下済み → スキップ**
  - リライト提案は「新規記事」として投稿されURLが元記事と一致しないため、重複検出は
    **タイトルマーカー `【AI提案/…】<元記事タイトル>`** の照合で行う（`src/analyze/dedup.ts`）。
  - 新規提案はクエリと publish/draft/trash のタイトル・スラッグの一致/部分一致で照合。
  - 提案メタ（実行日・タイプ・対象クエリ・現状数値、リライトはタイトル案3つ）は下書き本文冒頭の
    HTMLコメントに記録。振り返りはWP管理画面の下書き/ゴミ箱で足りる。
- **却下記録の30日制限**: WordPressのゴミ箱は既定で**約30日後に自動完全削除**される。30日以上前に却下したテーマは再提案されうる（トレンドも変わるため実害は小）。恒久的に残したい場合の将来オプション: 却下記事を削除せず下書きに戻しタイトルに `【却下】` を付けて残す運用（スコープ外）。

## 運用フロー（人間の作業）

1. **月曜朝**: WP管理画面 → 投稿 → 下書き一覧で `【AI提案/…】` を開く
2. 本文と冒頭コメント（提案理由・タイトル案3つ）を確認
3. **タイトルを選定**（コメントの3案から選ぶ／自分で決める）し、本文を編集
4. **価格など要確認箇所を補完**（本ルーチンは景表法配慮で価格金額を書かない。公式サイト/Amazon/楽天の最新価格へ誘導する文面になっているので、必要なら手動で確認・調整）
5. 問題なければ**公開**、不要なら**ゴミ箱**へ（＝次回以降スキップされる）

## セットアップ（ローカル開発）

```bash
npm install
cp .env.example .env   # 値を埋める（下記「環境変数」参照）
npm start              # 1回実行して終了。DRY_RUN=true ならWP投稿せずログ（候補一覧）のみ
```

- `DRY_RUN=true`（既定）で「今週なら何件・どの記事のドラフトを作るか」＋各ルールの通過件数＋**閾値感度分析**を出力（投稿なし）。
- `npm run typecheck` で型チェック。

## 環境変数一覧

`.env.example` も参照。

| 変数 | 種別 | 説明 |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 機密 | サービスアカウントJSONを**base64エンコードした1行**文字列（GSC/GA4認証） |
| `GA4_PROPERTY_ID` | 機密 | GA4プロパティID（数字。例 `515390600`） |
| `GSC_SITE_URL` | 機密 | `https://recovery-wear-guide.com/`（ドメインプロパティなら `sc-domain:recovery-wear-guide.com`） |
| `WP_BASE_URL` | 機密 | `https://recovery-wear-guide.com` |
| `WP_USERNAME` | 機密 | アプリケーションパスワードを発行したWPユーザー名 |
| `WP_APP_PASSWORD` | 機密 | アプリケーションパスワード（前後空白は自動trim） |
| `ANTHROPIC_API_KEY` | 機密 | Claude APIキー |
| `ANTHROPIC_MODEL` | 任意 | 生成モデル（既定 `claude-sonnet-5`） |
| `MAX_DRAFTS_PER_RUN` | 設定 | 1回の生成上限（既定 `3`） |
| `LOOKBACK_DAYS` | 設定 | 分析日数（既定 `28`） |
| `DATA_DELAY_DAYS` | 設定 | GSC遅延考慮。分析終端＝実行日−N日（既定 `3`） |
| `DRY_RUN` | 設定 | `true`=投稿せずログのみ / `false`=下書き投稿する |
| `USE_BATCH` | 設定 | `true`=Batch API（50%オフ・既定） / `false`=同期API（デバッグ用） |
| `BATCH_POLL_INTERVAL_MS` | 任意 | Batchポーリング間隔（既定 `15000`） |
| `BATCH_MAX_WAIT_MS` | 任意 | Batchタイムアウト（既定 `1800000`＝30分） |

## GitHub Secrets / Variables（本番）

**プライベート**リポジトリで Settings → Secrets and variables → Actions に登録。`weekly.yml` が env にマップする。

- **Secrets（機密）**: `GOOGLE_SERVICE_ACCOUNT_JSON` / `GA4_PROPERTY_ID` / `GSC_SITE_URL` / `WP_BASE_URL` / `WP_USERNAME` / `WP_APP_PASSWORD` / `ANTHROPIC_API_KEY`
- **Variables（非機密）**: `MAX_DRAFTS_PER_RUN`(=3) / `LOOKBACK_DAYS`(=28) / `DRY_RUN`(本番=`false`) / `USE_BATCH`(=`true`)

サービスアカウントJSONのbase64化（例・PowerShell、中身を画面に出さない）:
```powershell
$src = "C:\path\to\service-account.json"
[Convert]::ToBase64String([IO.File]::ReadAllBytes($src)) | Set-Clipboard  # クリップボード経由でSecretに貼る
```

手動実行: Actions タブ → `weekly-seo-routine` → **Run workflow**（ブランチ main）。

## 閾値の調整方法

閾値は `src/analyze/thresholds.ts` の `DEFAULT_THRESHOLDS` を編集（§4準拠）。

| ルール | 既定条件 | 調整箇所 |
|---|---|---|
| R1 タイトル/メタ改善 | 順位≤10 かつ CTR<3% かつ Imp≥200 | `r1` |
| R2 順位下落 | 前期比で平均順位が3以上悪化 かつ 前期クリック≥10 | `r2` |
| R3 惜しい順位 | 平均順位11〜20 かつ Imp≥100（小規模サイト向けに300→100へ緩和済み） | `r3` |
| N1 受け皿なしクエリ | クエリImp≥100 かつ 受け皿が専用記事でない | `n1` |
| N2 意図分離 | 1記事に意図の異なるクラスタが複数（要Claude判断） | `n2` |
| N2 カニバリ除外 | 分離候補クエリを既存公開記事が10位以内(クエリ/記事全体)で表示中なら除外 | `n2.excludeIfPublishedRankWithin` |

`DRY_RUN=true` 実行時に**閾値感度分析**（例: R1 Imp 200→150→100→50 で候補が何件になるか）が出るので、それを見て調整する。

## リポジトリ構成

```
.github/workflows/weekly.yml  # GitHub Actions: cron週1実行 + 手動実行
src/
├── index.ts              # エントリポイント（取得→抽出→dedup→生成→投稿→サマリー）
├── config.ts             # 環境変数の読み込み・検証
├── fetch/                # gsc.ts / ga4.ts / googleAuth.ts / wp.ts
├── analyze/              # aggregate.ts / rewriteCandidates.ts / newArticleCandidates.ts
│                         # / dedup.ts / pipeline.ts / thresholds.ts / types.ts
├── generate/             # prompts.ts / draft.ts（同期）/ batch.ts（Batch API）
└── util/                 # urlNormalize.ts / dateRange.ts / logger.ts
```

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| WP取得/投稿が 403 | Xserver REST API 海外IP制限がON。→ OFFにする（常時OFF運用）。または Wordfence がBotブロック → ライブトラフィックで確認 |
| WP GET draft/trash が 400 `rest_invalid_param` | 認証が効いていない（＝未認証扱い）。`WP_USERNAME`/`WP_APP_PASSWORD` の値を確認（末尾改行・取り違えに注意） |
| WP 投稿が 401 | 同上（認証情報の誤り）。アプリケーションパスワードを再確認 |
| `fetch failed`（EAI_AGAIN/ENOTFOUND） | 対象ドメインのDNS一時障害。時間をおいて再実行 |
| GSC/GA4 が 403/権限エラー | サービスアカウントに GSCフル権限 / GA4閲覧者権限が付いているか、API有効化済みか確認 |
| Claude 生成が空/JSON化失敗 | モデルIDが有効か、`max_tokens` 到達で途切れていないか確認 |
| Batchがタイムアウト | `BATCH_MAX_WAIT_MS` を延長。個別失敗はその候補だけスキップされ他は継続 |
| 候補が毎回0件 | 既に3件とも提案済み（draft）でスキップされている可能性。下書き/ゴミ箱の状況を確認 |
| 同じ記事が再提案される | 提案下書きを削除した／ゴミ箱30日経過で消えた。dedupはWP上の下書き/ゴミ箱に依存 |

## 実装状況

計画書 `seo-weekly-routine-plan.md` §9 に沿って構築完了：
- ✅ step1 スキャフォールド
- ✅ step2〜3 状態管理はWP（外部DB不使用）／WP REST疎通（ローカル＋GitHub Actions海外IPで読み書き検証）
- ✅ step4 GSC/GA4クライアント・実データ取得
- ✅ step5 候補抽出（R1-R3/N1-N2）＋WPで重複・却下スキップ＋閾値感度分析
- ✅ step6-7 ドラフト生成（薬機法・景表法配慮、価格金額は書かない）＋新規下書き投稿（元記事不変）
- ✅ step8 全体結合＋Batch API（50%オフ・非同期ポーリング）でエンドツーエンド実行
- ✅ step9 GitHub Actions で手動実行検証 → cron有効化
- ✅ step10 README整備

将来拡張（スコープ外）: Slack/LINE通知、公開後の効果測定レポート、robots.txt へのAIクローラー明示Allow。
