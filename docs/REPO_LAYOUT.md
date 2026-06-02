# Suggested Repository Layout

```text
repo-root/
  README.md
  LICENSE
  .gitignore
  docs/
    PUBLICATION_POLICY.md
    REPO_LAYOUT.md
    WORKFLOW.md
  metadata/
    README.md
    localized-records.txt
  scripts/
    pqtc_text_manifest.json
    export_ppp_record.mjs
    pqtc_record_patch.mjs
    extract_localization_targets.mjs
    apply_localization_targets.mjs
    generate_localized_record_list.mjs
    build_publish_bundle.ps1
  work/
    source/
```

## Notes

- `metadata/localized-records.txt` は公開しやすい一覧です
- 実際のゲーム本文は含めません
- 翻訳作業は `work/source/` に抽出して進めます
