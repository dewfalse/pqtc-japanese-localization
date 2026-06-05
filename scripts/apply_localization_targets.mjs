import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const metadataPath = path.join(repoRoot, "metadata", "localized-records.txt");
const copyMetadataPath = path.join(repoRoot, "metadata", "record-copies.txt");
const patchScript = path.join(import.meta.dirname, "pqtc_record_patch.mjs");

function usage() {
  console.log([
    "Usage:",
    '  node scripts/apply_localization_targets.mjs --game-dir "<PQTC dir>" [--from-root "<dir>"]',
    "",
    "Defaults:",
    '  from-root = "<repo>/work/source"',
  ].join("\n"));
}

function parseArgs(argv) {
  let gameDir = "";
  let fromRoot = path.join(repoRoot, "work", "source");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--game-dir") {
      gameDir = argv[++i] ?? "";
    } else if (arg === "--from-root") {
      fromRoot = path.resolve(repoRoot, argv[++i] ?? "");
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!gameDir) throw new Error("Missing --game-dir");
  return { gameDir: path.resolve(gameDir), fromRoot };
}

function loadRecordList() {
  return fs.readFileSync(metadataPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function loadRecordCopies() {
  if (!fs.existsSync(copyMetadataPath)) return [];
  return fs.readFileSync(copyMetadataPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [target, source] = line.split(/\t+/);
      if (!target || !source) throw new Error(`Invalid record copy line: ${line}`);
      return { target, source };
    });
}

function localPathForRecord(root, recordName) {
  return path.join(root, ...recordName.split("\\"));
}

function main() {
  const { gameDir, fromRoot } = parseArgs(process.argv.slice(2));
  const records = loadRecordList();
  const copies = loadRecordCopies();

  for (const [index, recordName] of records.entries()) {
    const localFile = localPathForRecord(fromRoot, recordName);
    if (!fs.existsSync(localFile)) {
      console.log(`[skip ${index + 1}/${records.length}] ${recordName} (missing local file)`);
      continue;
    }
    console.log(`[${index + 1}/${records.length}] ${recordName}`);
    const result = spawnSync(
      process.execPath,
      [patchScript, "patch", "--game-dir", gameDir, recordName, localFile, "--apply"],
      { cwd: repoRoot, stdio: "inherit" }
    );
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }

  for (const [index, copy] of copies.entries()) {
    console.log(`[copy ${index + 1}/${copies.length}] ${copy.target} <- ${copy.source}`);
    const result = spawnSync(
      process.execPath,
      [patchScript, "copy", "--game-dir", gameDir, copy.target, copy.source, "--apply"],
      { cwd: repoRoot, stdio: "inherit" }
    );
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
