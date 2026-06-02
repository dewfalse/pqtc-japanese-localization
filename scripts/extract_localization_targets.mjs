import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const metadataPath = path.join(repoRoot, "metadata", "localized-records.txt");
const exportScript = path.join(import.meta.dirname, "export_ppp_record.mjs");

function usage() {
  console.log([
    "Usage:",
    '  node scripts/extract_localization_targets.mjs --game-dir "<PQTC dir>" [--out-root "<dir>"]',
    "",
    "Defaults:",
    '  out-root = "<repo>/work/source"',
  ].join("\n"));
}

function parseArgs(argv) {
  let gameDir = "";
  let outRoot = path.join(repoRoot, "work", "source");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--game-dir") {
      gameDir = argv[++i] ?? "";
    } else if (arg === "--out-root") {
      outRoot = path.resolve(repoRoot, argv[++i] ?? "");
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!gameDir) throw new Error("Missing --game-dir");
  return { gameDir: path.resolve(gameDir), outRoot };
}

function loadRecordList() {
  return fs.readFileSync(metadataPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const { gameDir, outRoot } = parseArgs(process.argv.slice(2));
  const records = loadRecordList();

  fs.mkdirSync(outRoot, { recursive: true });
  console.log(`Exporting ${records.length} records to ${outRoot}`);

  for (const [index, recordName] of records.entries()) {
    console.log(`[${index + 1}/${records.length}] ${recordName}`);
    const result = spawnSync(
      process.execPath,
      [exportScript, "--game-dir", gameDir, "--out-root", outRoot, recordName],
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
