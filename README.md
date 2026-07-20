# seo-weekly-routine

recovery-wear-guide.com の週次SEOルーチン。週1回自動実行し、Search Console / GA4 のデータから
「リライトすべき既存記事」「新規に書くべき記事」を判定 → Claude API でドラフト生成 →
WordPress に**下書き（status=draft）**として自動投稿する。

人間の作業は週1回、WP管理画面の下書き一覧をレビュー → 公開 or 破棄のみ。

## 技術スタック

- Node.js 20 + TypeScript（ESM / tsx 実行）
- googleapis（Search Console API / GA4 Data API、サービスアカウントJWT認証）
- WP REST API + アプリケーションパスワード（Basic認証）
- Claude API（`@anthropic-ai/sdk`）
- 外部データベースなし。提案履歴・重複判定・却下判定は WordPress 自身の記事ステータスで管理
- GitHub Actions（`on: schedule` cron）で週1回 `npm start`（アプリ内cronは持たない・コスト0円運用）

## 稼働環境

- **スケジューラ**: GitHub Actions。`.github/workflows/weekly.yml` が日曜22:00 UTC（=月曜07:00 JST）に自動実行。`workflow_dispatch` で手動実行も可能。ランナーは `ubuntu-latest`（Linuxのみ／無料枠節約）。
- **状態管理（外部DBなし）**: 「何を提案し、何を採用/却下したか」は WordPress 自身が持っている。投稿前に WP REST API で記事ステータスを読んで判定する:
  - `publish`（公開済み）: リライト対象の母集団 / 新規テーマの受け皿有無
  - `draft`（下書き＝提案済み未レビュー）: 同一URLがあれば**提案済み → スキップ**
  - `trash`（ゴミ箱＝却下済み）: 同一URL/同種テーマがあれば**却下済み → スキップ**
  - 提案メタ（実行日・タイプ・対象クエリ・現状数値）は下書き本文冒頭のHTMLコメントに記録するので、振り返りはWP管理画面の下書き/ゴミ箱で足りる。
- **却下記録の30日制限**: WordPressのゴミ箱は既定で**約30日後に自動完全削除**される。よって30日以上前に却下したテーマは再提案されうる。トレンドも変化するため実害は小さいが仕様として明記する。恒久的に却下を残したい場合の将来オプション: 却下記事を削除せず下書きに戻しタイトルに `【却下】` を付けて残す運用（今回はスコープ外）。
- **ローカル / 本番の二本立て**: ローカルは `.env`（dotenv）を読む。本番は GitHub Secrets / Variables を workflow の `env` にマップする。

## セットアップ（ローカル）

```bash
npm install
cp .env.example .env   # 値を埋める（下記「環境変数」参照）
npm start              # 1回実行して終了。DRY_RUN=true ならWP投稿せずログのみ
```

## GitHub Secrets / Variables の設定（本番）

**プライベート**リポジトリに push し、Settings → Secrets and variables → Actions で登録する。

**Secrets（機密。値は表示されない）**

| Secret 名 | 中身 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウントJSONをbase64エンコードした1行文字列 |
| `GA4_PROPERTY_ID` | GA4プロパティID（数字） |
| `GSC_SITE_URL` | `https://recovery-wear-guide.com/`（またはドメインプロパティなら `sc-domain:recovery-wear-guide.com`） |
| `WP_BASE_URL` | `https://recovery-wear-guide.com` |
| `WP_USERNAME` | アプリケーションパスワードを発行したユーザー名 |
| `WP_APP_PASSWORD` | 発行されたアプリケーションパスワード |
| `ANTHROPIC_API_KEY` | Claude APIキー |

**Variables（非機密の動作設定）**

| Variable 名 | 例 |
|---|---|
| `MAX_DRAFTS_PER_RUN` | `3` |
| `LOOKBACK_DAYS` | `28` |
| `DRY_RUN` | 初期検証は `true`、本番投稿時に `false` |

手動実行: Actions タブ → `weekly-seo-routine` → **Run workflow**（`workflow_dispatch`）。

## リポジトリ構成

```
.github/workflows/weekly.yml  # GitHub Actions: cron週1実行 + 手動実行
src/
├── index.ts              # エントリポイント（1回実行して終了）
├── config.ts             # 環境変数の読み込み・検証
├── fetch/                # gsc.ts / ga4.ts / wp.ts（publish/draft/trash取得・下書き投稿）
├── analyze/              # rewriteCandidates.ts / newArticleCandidates.ts / dedup.ts / types.ts
├── generate/             # prompts.ts / draft.ts
└── util/                 # urlNormalize.ts / logger.ts
```

## 環境変数

`.env.example` を参照。詳細な一覧・調整方法・トラブルシューティングは step10 で追記する。

## 構築ステップ

計画書 `seo-weekly-routine-plan.md` §9 の順で構築中。進捗:
- ✅ step1 スキャフォールド
- ✅ step3 WP REST API疎通（ローカル＋GitHub Actions海外IPで読み書き検証済み）
- ✅ step4 GSC/GA4クライアント実装・実データ取得確認
- ⬜ step5 候補抽出（リライト/新規）＋WPで重複・却下スキップ ← 次
