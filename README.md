# PDF/Image to Editable PPTX Converter

PDFまたは画像から「見た目を維持したまま編集可能なPowerPoint（.pptx）」を生成するWebアプリケーション。

## デモ

GitHub Pagesでホストして利用できます。

## コア設計：2レイヤー構造

このツールは単なる変換ではなく**再構築**です。

1. **背景レイヤー** - テキストを除去した画像
2. **テキストレイヤー** - 座標・サイズを維持して再配置したテキスト

## 技術スタック

| 用途 | 技術 |
|------|------|
| フロントエンド | HTML / CSS / JavaScript (ES Modules) |
| PDF解析 | PDF.js v3.11 |
| PPT生成 | PptxGenJS v4.0 |
| OCR / テキスト検出 | OpenAI GPT-4o Vision API |
| 画像処理 | Canvas API |

## 処理パイプライン

```
STEP1: ファイル解析 (PDF.js / Canvas)
STEP2: 座標正規化 (相対座標 0-1 に変換)
STEP3: テキスト領域抽出 (バウンディングボックス生成)
STEP4: 背景生成 (テキスト除去 + 背景補完)
STEP5: OCR実行 (画像入力時、API経由)
STEP6: テキスト構造化 (行・段落グルーピング)
STEP7: 座標変換 (PPTX座標系へスケーリング)
STEP8: PPTX生成 (2レイヤー構造で出力)
```

## 使い方

### 前提条件

- OpenAI APIキー（GPT-4o対応）

### 手順

1. ブラウザで `index.html` を開く（またはGitHub Pagesにデプロイ）
2. 右上の入力欄にOpenAI APIキーを入力
3. PDF または 画像ファイルをドラッグ＆ドロップ
4. 「変換開始」ボタンをクリック
5. 処理完了後「PPTXダウンロード」ボタンでファイルを取得

### GitHub Pagesへのデプロイ

1. このリポジトリをfork
2. Settings → Pages → Source: main branch を選択
3. 数分後に `https://[username].github.io/[repo-name]/` でアクセス可能

## ファイル構成

```
index.html          - メインUI (HTML/CSS)
main.js             - オーケストレーター（全モジュール統合）
ui.js               - UIコントローラー
pdfProcessor.js     - PDF解析・テキスト抽出・座標正規化
imageProcessor.js   - 画像処理・テキストマスキング・背景生成
openaiClient.js     - OpenAI API統合（OCR・テキスト検出）
pptGenerator.js     - PPTX生成（2レイヤー構造）
```

## 対応ファイル形式

- **入力**: PDF, PNG, JPG/JPEG, WEBP
- **出力**: PPTX (Microsoft PowerPoint)

## 注意事項

- OpenAI APIの利用料金が発生します
- 大きなPDFファイルは処理に時間がかかります
- APIキーはブラウザのlocalStorageに保存されます（サーバーには送信されません）
- 「AIテキスト除去」オプションを無効にすると、APIコールを削減できます
