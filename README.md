# PQTC Japanese Localization

`Plebby Quest: The Crusades` 向けの日本語化作業用リポジトリです。

このリポジトリは、ゲーム本体のデータを再配布せずに、

1. 自分のゲームから翻訳対象を抽出する
2. 抽出したファイルを翻訳する
3. 翻訳済みファイルを自分のゲームへ適用する

ためのスクリプトと手順をまとめたものです。

## できること

- `all.ppp` から翻訳対象レコードを抽出する
- 抽出した JSON / TXT / SB を翻訳する
- 翻訳済みファイルを `all.ppp` へ順番に適用する

## このリポジトリに含まれるもの

- 抽出スクリプト
- 適用スクリプト
- 翻訳対象レコード一覧
- 手順書
- 公開ポリシー

## このリポジトリに含めないもの

- `all.ppp`
- `all.ppp.bak`
- `PQTC.exe`
- ゲームから抽出した全文データ
- 画像、音声、フォントなどのゲームアセット

## 前提

- Steam 版 `Plebby Quest: The Crusades` を所持している
- Node.js が使える
- このリポジトリを任意の場所に置いている

このリポジトリは、**ゲームフォルダの中に置かなくても使えます**。  
コマンド実行時に `--game-dir` でゲームのインストール先を指定します。

## 用語

- **リポジトリのルート**  
  この README があるフォルダ
- **ゲームフォルダ**  
  `all.ppp` があるフォルダ  
  例: `C:\Program Files (x86)\Steam\steamapps\common\PQTC`

以下のコマンドは、**すべてリポジトリのルートで実行**します。

## クイックスタート

### 1. ゲームをバックアップする

ゲームフォルダで `all.ppp` を退避します。

例:

```text
C:\Program Files (x86)\Steam\steamapps\common\PQTC\all.ppp
->
C:\Program Files (x86)\Steam\steamapps\common\PQTC\all.ppp.bak
```

### 2. 翻訳対象を抽出する

```powershell
node .\scripts\extract_localization_targets.mjs --game-dir "C:\Program Files (x86)\Steam\steamapps\common\PQTC"
```

この処理で、`metadata/localized-records.txt` に列挙された対象レコードが  
`work/source/` 以下へ展開されます。

既定の出力先:

```text
work/source/
```

### 3. 抽出したファイルを翻訳する

翻訳作業は `work/source/` 以下で行います。

例:

- `work/source/Texts/Actor_ZHT.json`
- `work/source/Texts/Flag_ZHT.json`
- `work/source/Doc/Help/Index.json`

翻訳対象一覧:

- [localized-records.txt](metadata/localized-records.txt)
- [record-copies.txt](metadata/record-copies.txt)

### 4. 翻訳済みファイルをゲームへ適用する

```powershell
node .\scripts\apply_localization_targets.mjs --game-dir "C:\Program Files (x86)\Steam\steamapps\common\PQTC"
```

この処理は `work/source/` のファイルを 1 件ずつ順番に `all.ppp` へ適用します。

### 5. ゲームで確認する

適用後にゲームを起動して、日本語表示を確認します。

## 手順の詳細

### 抽出で使うスクリプト

- [extract_localization_targets.mjs](scripts/extract_localization_targets.mjs)  
  `localized-records.txt` を読んで、対象レコードをまとめて抽出します。
- [export_ppp_record.mjs](scripts/export_ppp_record.mjs)  
  1 レコードずつ `all.ppp` から展開します。
- [pqtc_text_manifest.json](scripts/pqtc_text_manifest.json)  
  レコード復号に必要なマニフェストです。

### 適用で使うスクリプト

- [apply_localization_targets.mjs](scripts/apply_localization_targets.mjs)  
  `work/source/` の翻訳済みファイルを順番に適用します。
- [pqtc_record_patch.mjs](scripts/pqtc_record_patch.mjs)  
  1 レコードずつ `all.ppp` にパッチを当てます。
- [pqtc_text_manifest.json](scripts/pqtc_text_manifest.json)  
  レコード再パックに必要なマニフェストです。

## 個別にレコードを扱う方法

### 個別抽出

```powershell
node .\scripts\export_ppp_record.mjs --game-dir "C:\Program Files (x86)\Steam\steamapps\common\PQTC" "Texts\Actor_ZHT.json"
```

### 個別適用

```powershell
node .\scripts\pqtc_record_patch.mjs patch --game-dir "C:\Program Files (x86)\Steam\steamapps\common\PQTC" "Texts\Actor_ZHT.json" ".\work\source\Texts\Actor_ZHT.json" --apply
```

### 個別 dry-run

適用前に、書き込みなしで確認だけしたい場合:

```powershell
node .\scripts\pqtc_record_patch.mjs check --game-dir "C:\Program Files (x86)\Steam\steamapps\common\PQTC" "Texts\Actor_ZHT.json" ".\work\source\Texts\Actor_ZHT.json"
```

## 生成されるもの

- `work/source/`
  - 抽出された翻訳対象ファイル
- `dist/`
  - `build_publish_bundle.ps1` で作る配布用の整理済みフォルダ

## よくある注意点

- **適用は必ず順番に行ってください。**
  複数レコードの並列適用は `all.ppp` を壊す可能性があります。
- 先に `all.ppp.bak` を作っておくと復旧が楽です。
- ゲーム本体や抽出済み全文データの再配布は避けてください。

## 復旧方法

問題が起きたら、退避しておいた `all.ppp.bak` を元に戻してください。

```text
all.ppp.bak -> all.ppp
```

## 関連ドキュメント

- [WORKFLOW.md](docs/WORKFLOW.md)
- [PUBLICATION_POLICY.md](docs/PUBLICATION_POLICY.md)
- [REPO_LAYOUT.md](docs/REPO_LAYOUT.md)
