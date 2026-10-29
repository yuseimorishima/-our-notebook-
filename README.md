# みんなのノート / Our Notebook

ユーザー名とパスワードで使える日本語のノートアプリです。

- 個人の学習ノート：作成者だけが閲覧・編集できます。
- 共有ノート：登録ユーザー全員が閲覧・編集できます。
- 公開範囲の変更・削除：作成者だけが操作できます。
- タイトル・本文検索、手動保存、未保存の変更を破棄する前の確認に対応します。
- 編集が競合すると上書きを防ぎます。「再読み込み」で最新の内容を取得してください。リアルタイム同期ではありません。

## 開発

Node.js 22以上（24で確認済み）とnpmを使います。

```sh
cd /workspace/-our-notebook-
npm ci
npm run dev
```

ポート3000で起動します。画面の「新規登録」からアカウントを作成してください。既定アカウントはありません。SQLiteは初回リクエスト時に `data/notebook.sqlite` に作成されます。実データはGitに含めません。依存関係はこのリポジトリで管理しており、以前の環境検証用 `.notebook-tooling` は不要です。

## 検証

```sh
npm run typecheck
npm run build
```

API統合テストは一時データベースの専用サーバーで実行してください。普段使いや本番のDBでは実行しないでください。

```sh
# ターミナル1：ビルド後、新しい一時DBで起動
NOTEBOOK_DB_PATH="$(mktemp -d)/test.sqlite" NOTEBOOK_COOKIE_SECURE=false npm run start -- --port 3102
# ターミナル2
NOTEBOOK_TEST_URL=http://127.0.0.1:3102 npm test
```

登録、ログイン、個人ノートのアクセス制御、共有ノートの編集権限、競合検出、CSRF防止、入力検証、ログアウト、試行回数制限を検証します。

## 公開時の設定

| 環境変数 | 用途 | 既定値 |
| --- | --- | --- |
| `NOTEBOOK_DB_PATH` | SQLiteファイルのパス | `data/notebook.sqlite` |
| `APP_ORIGIN` | 公開URL（末尾スラッシュなし） | リクエストのホスト |
| `NOTEBOOK_COOKIE_SECURE` | HTTPS限定Cookie | 本番true、開発false |

本番は `npm run build` → `npm start` で起動します。HTTPSと `APP_ORIGIN`（例 `https://notes.example.com`）を設定し、Secure Cookieを有効にしてください。`NOTEBOOK_COOKIE_SECURE=false` はローカルHTTP検証専用です。

パスワードはbcryptハッシュで保存します。セッションは7日間有効なランダムトークンをHttpOnly Cookieで保持し、DBにはトークンのSHA-256ハッシュだけを保存します。ユーザー名はUnicode正規化・小文字化されます。パスワードは10文字以上・UTF-8で72バイト以内です。

SQLiteを保持する永続ディスク付きの単一Node.jsサーバーを想定しています。複数インスタンスやサーバーレス配備ではDB構成の見直しが必要です。稼働中のDBバックアップにはSQLiteのバックアップ機能を使ってください。

初版にはパスワード再設定・メール認証・招待制登録・添付ファイル・変更履歴・リアルタイム共同編集はありません。登録した全員がすべての共有ノートを使えます。インターネット公開や大人数運用の前に、登録方針・永続保存・バックアップ・監視・追加の不正利用対策を決めてください。デザインは今後調整する前提です。
