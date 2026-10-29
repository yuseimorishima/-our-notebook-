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
NOTEBOOK_DB_PATH="$(mktemp -d)/test.sqlite" NOTEBOOK_COOKIE_SECURE=false ADMIN_USER_ID=1 npm run start -- --port 3102
# ターミナル2
NOTEBOOK_TEST_URL=http://127.0.0.1:3102 npm test
```

登録、ログイン、個人ノートのアクセス制御、共有ノートの編集権限、競合検出、CSRF防止、入力検証、ログアウト、試行回数制限、管理者権限、利用停止・再開を検証します。テスト用の空DBでは最初のユーザーを管理者にするため `ADMIN_USER_ID=1` を指定します。実際の公開では自分のアカウントのIDを確認して設定してください。

## 公開時の設定

Vercel Hobby + Tursoの無料枠で公開できる構成に対応しています。有料ディスクは不要です。無料枠の条件と手順は [公開手順](docs/deploy.md) を参照してください。GitHubへの保存だけではサイトは公開されません。管理者ページは `/admin` です。

| 環境変数 | 用途 | 既定値 |
| --- | --- | --- |
| `TURSO_DATABASE_URL` | Tursoの接続URL | 未設定（ローカル開発） |
| `TURSO_AUTH_TOKEN` | DBの読み書き用認証トークン（秘密情報） | 未設定 |
| `ADMIN_USER_ID` | 管理者本人のユーザーID | 未設定（管理者なし） |
| `NOTEBOOK_DB_PATH` | SQLiteファイルのパス | `data/notebook.sqlite` |
| `APP_ORIGIN` | 公開URL（末尾スラッシュなし） | リクエストのホスト |
| `NOTEBOOK_COOKIE_SECURE` | HTTPS限定Cookie | 本番true、開発false |

本番は `npm run build` → `npm start` で起動します。HTTPSと `APP_ORIGIN`（例 `https://notes.example.com`）を設定し、Secure Cookieを有効にしてください。`NOTEBOOK_COOKIE_SECURE=false` はローカルHTTP検証専用です。

パスワードはbcryptハッシュで保存します。セッションは7日間有効なランダムトークンをHttpOnly Cookieで保持し、DBにはトークンのSHA-256ハッシュだけを保存します。ユーザー名はUnicode正規化・小文字化されます。パスワードは10文字以上・UTF-8で72バイト以内です。

ローカルSQLiteを使う場合は単一サーバーと永続ディスクが必要です。サーバーレス公開時は `TURSO_DATABASE_URL` と `TURSO_AUTH_TOKEN` を設定し、外部Turso DBへ保存します。ローカルDBのバックアップにはSQLiteのバックアップ機能を使ってください。Turso利用時は同サービスのバックアップ・エクスポート手段を確認してください。

初版にはパスワード再設定・メール認証・招待制登録・添付ファイル・変更履歴・リアルタイム共同編集はありません。登録した全員がすべての共有ノートを使えます。インターネット公開や大人数運用の前に、登録方針・永続保存・バックアップ・監視・追加の不正利用対策を決めてください。デザインは今後調整する前提です。
