# Workflow

このドキュメントは、未翻訳状態のゲームから日本語化を進める手順を短くまとめたものです。

## 1. バックアップ

ゲームインストール先の `all.ppp` を `all.ppp.bak` として退避します。

## 2. 翻訳対象の抽出

リポジトリのルートで実行:

```powershell
node .\scripts\extract_localization_targets.mjs --game-dir "C:\Program Files (x86)\Steam\steamapps\common\PQTC"
```

内部で使うもの:
- `scripts/extract_localization_targets.mjs`
- `scripts/export_ppp_record.mjs`
- `scripts/pqtc_text_manifest.json`
- `metadata/localized-records.txt`

## 3. 翻訳

`work/source/` 以下に展開されたファイルを編集します。

## 4. 適用

リポジトリのルートで実行:

```powershell
node .\scripts\apply_localization_targets.mjs --game-dir "C:\Program Files (x86)\Steam\steamapps\common\PQTC"
```

内部で使うもの:
- `scripts/apply_localization_targets.mjs`
- `scripts/pqtc_record_patch.mjs`
- `scripts/pqtc_text_manifest.json`

## 5. 確認

ゲームを起動して表示を確認します。

## 6. 復旧

問題があれば `all.ppp.bak` から `all.ppp` を戻します。
