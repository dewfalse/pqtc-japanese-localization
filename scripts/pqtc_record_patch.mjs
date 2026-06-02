import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(import.meta.dirname, "pqtc_text_manifest.json");

function usage() {
  console.log([
    "Usage:",
    '  node scripts/pqtc_record_patch.mjs patch --game-dir "<PQTC dir>" "<recordName>" "<localFile>" [--apply]',
    '  node scripts/pqtc_record_patch.mjs check --game-dir "<PQTC dir>" "<recordName>" "<localFile>"',
  ].join("\n"));
}

function parseArgs(argv) {
  const args = [...argv];
  const cmd = args.shift();
  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
    process.exit(0);
  }
  let gameDir = "";

  while (args[0] === "--game-dir") {
    args.shift();
    gameDir = args.shift() ?? "";
  }

  const recordName = args.shift();
  const localFile = args.shift();
  const flag = args.shift();

  if (!gameDir) throw new Error("Missing --game-dir");

  return {
    cmd,
    recordName,
    localFile,
    flag,
    allPath: path.join(path.resolve(gameDir), "all.ppp"),
  };
}

const parsed = parseArgs(process.argv.slice(2));
const allPath = parsed.allPath;

function loadManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function readU32(buf, off) {
  return buf.readUInt32LE(off);
}

function writeU32(buf, off, value) {
  buf.writeUInt32LE(value >>> 0, off);
}

function keyAt(manifest, index) {
  return manifest.keyTable[index & 0xff] >>> 0;
}

function decodeHeaderBlock(manifest, encrypted) {
  const buf = Buffer.from(encrypted);
  for (let i = 0; i < 3; i++) {
    writeU32(buf, i * 4, (readU32(buf, i * 4) - keyAt(manifest, 13 + i)) >>> 0);
  }
  const first = readU32(buf, 0);
  writeU32(buf, 0, (first ^ 0x18385865) >>> 0);
  writeU32(buf, 4, (readU32(buf, 4) ^ first) >>> 0);
  return buf;
}

function encodeHeaderBlock(manifest, decoded) {
  const buf = Buffer.from(decoded);
  const plainFirst = readU32(buf, 0);
  const encryptedFirst = (plainFirst ^ 0x18385865) >>> 0;
  writeU32(buf, 0, encryptedFirst);
  writeU32(buf, 4, (readU32(buf, 4) ^ encryptedFirst) >>> 0);
  for (let i = 0; i < 3; i++) {
    writeU32(buf, i * 4, (readU32(buf, i * 4) + keyAt(manifest, 13 + i)) >>> 0);
  }
  return buf;
}

function updateHeaderChecksum(decoded) {
  const byte0 = decoded[0];
  const byte4 = decoded[4];
  const byte11 = decoded[11];
  const byte12IsNonZero = decoded[12] !== 0 ? 1 : 0;
  decoded[9] = (~(((byte0 ^ byte12IsNonZero) * byte4 + byte11) & 0xff)) & 0xff;
}

function readHeader(manifest) {
  const headerOffset = manifest.headerOffset ?? 0xe5;
  const fd = fs.openSync(allPath, "r");
  try {
    const encrypted = Buffer.alloc(16);
    fs.readSync(fd, encrypted, 0, encrypted.length, headerOffset);
    const decoded = decodeHeaderBlock(manifest, encrypted);
    return {
      headerOffset,
      decoded,
      fileNum: readU32(decoded, 0),
      indexOffset: readU32(decoded, 4),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function signedModulo125(lo, hi) {
  let value = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  if ((hi & 0x80000000) !== 0) value -= 1n << 64n;
  return Number(value % 125n);
}

function indexLocalByte(manifest, lo, hi) {
  const window = manifest.indexLocalWindow;
  const origin = manifest.indexLocalOrigin ?? 160;
  return window[origin + signedModulo125(lo, hi)] & 0xff;
}

function xorIndexAcf(manifest, buf, recordIndex) {
  const table = manifest.indexAcfTable;
  let seed = ((manifest.indexSeedStart ?? 1) + recordIndex) & 0xff;
  for (let p = 0; p < (manifest.indexRecordSize ?? 0x99); p += 4) {
    buf[p] ^= table[seed];
    seed = (seed + 4) & 0xff;
  }
}

function decodeIndexRecord(manifest, raw, recordIndex) {
  const recSize = manifest.indexRecordSize ?? 0x99;
  const buf = Buffer.from(raw);
  const lo = readU32(buf, 0);
  const hi = readU32(buf, 4);
  for (let i = 0; i < 0x20; i++) {
    const off = 8 + i * 4;
    writeU32(buf, off, (readU32(buf, off) - keyAt(manifest, 0x80 + i)) >>> 0);
  }
  const local = indexLocalByte(manifest, lo, hi);
  for (let p = 0; p < recSize; p += 4) buf[p] ^= local;
  writeU32(buf, 0, lo);
  writeU32(buf, 4, hi);
  xorIndexAcf(manifest, buf, recordIndex);
  return buf;
}

function encodeIndexRecord(manifest, decoded, recordIndex) {
  const recSize = manifest.indexRecordSize ?? 0x99;
  const buf = Buffer.from(decoded);
  xorIndexAcf(manifest, buf, recordIndex);
  const lo = readU32(buf, 0);
  const hi = readU32(buf, 4);
  const local = indexLocalByte(manifest, lo, hi);
  for (let p = 0; p < recSize; p += 4) buf[p] ^= local;
  writeU32(buf, 0, lo);
  writeU32(buf, 4, hi);
  for (let i = 0; i < 0x20; i++) {
    const off = 8 + i * 4;
    writeU32(buf, off, (readU32(buf, off) + keyAt(manifest, 0x80 + i)) >>> 0);
  }
  return buf;
}

function indexRecordName(decoded) {
  let end = decoded.indexOf(0, 8);
  if (end < 0 || end > 0x88) end = 0x88;
  return decoded.subarray(8, end).toString("utf8");
}

function fieldsFromIndexRecord(decoded) {
  const size2 =
    decoded[0x97] |
    (decoded[0x91] << 8) |
    (decoded[0x95] << 16) |
    (decoded[0x93] << 24);
  const size1 =
    decoded[0x94] |
    (decoded[0x96] << 8) |
    (decoded[0x92] << 16) |
    (decoded[0x98] << 24);
  return {
    dataOff: readU32(decoded, 0x8d),
    size1: size1 >>> 0,
    size2: size2 >>> 0,
  };
}

function setIndexRecordFields(decoded, fields) {
  writeU32(decoded, 0x8d, fields.dataOff >>> 0);
  decoded[0x94] = fields.size1 & 0xff;
  decoded[0x96] = (fields.size1 >>> 8) & 0xff;
  decoded[0x92] = (fields.size1 >>> 16) & 0xff;
  decoded[0x98] = (fields.size1 >>> 24) & 0xff;
  decoded[0x97] = fields.size2 & 0xff;
  decoded[0x91] = (fields.size2 >>> 8) & 0xff;
  decoded[0x95] = (fields.size2 >>> 16) & 0xff;
  decoded[0x93] = (fields.size2 >>> 24) & 0xff;
}

function readAllIndexRecords(manifest) {
  const header = readHeader(manifest);
  const recSize = manifest.indexRecordSize ?? 0x99;
  const fd = fs.openSync(allPath, "r");
  try {
    const out = [];
    for (let i = 0; i < header.fileNum; i++) {
      const raw = Buffer.alloc(recSize);
      fs.readSync(fd, raw, 0, recSize, header.indexOffset + i * recSize);
      const decoded = decodeIndexRecord(manifest, raw, i);
      out.push({
        index: i,
        name: indexRecordName(decoded),
        decoded,
        ...fieldsFromIndexRecord(decoded),
      });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

function readVarint(buf, state) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (state.pos >= buf.length) throw new Error("Truncated varint");
    const c = buf[state.pos++];
    value |= (c & 0x7f) << shift;
    if (c < 0x80) return value >>> 0;
    shift += 7;
    if (shift > 28) throw new Error("Varint too long");
  }
}

function snappyRawDecode(comp) {
  const state = { pos: 0 };
  const outLen = readVarint(comp, state);
  const out = Buffer.alloc(outLen);
  let op = 0;
  while (state.pos < comp.length) {
    const tag = comp[state.pos++];
    const type = tag & 3;
    if (type === 0) {
      let len = tag >>> 2;
      if (len < 60) {
        len += 1;
      } else {
        const n = len - 59;
        len = 0;
        for (let i = 0; i < n; i++) len |= comp[state.pos++] << (8 * i);
        len += 1;
      }
      comp.copy(out, op, state.pos, state.pos + len);
      state.pos += len;
      op += len;
      continue;
    }
    let len;
    let off;
    if (type === 1) {
      len = ((tag >>> 2) & 7) + 4;
      off = comp[state.pos++] | ((tag & 0xe0) << 3);
    } else if (type === 2) {
      len = (tag >>> 2) + 1;
      off = comp[state.pos] | (comp[state.pos + 1] << 8);
      state.pos += 2;
    } else {
      len = (tag >>> 2) + 1;
      off = comp[state.pos] | (comp[state.pos + 1] << 8) | (comp[state.pos + 2] << 16) | (comp[state.pos + 3] << 24);
      state.pos += 4;
    }
    for (let i = 0; i < len; i++) out[op + i] = out[op - off + i];
    op += len;
  }
  return out;
}

function splitOuter(raw) {
  const out = [];
  let pos = 0;
  while (pos < raw.length) {
    const len = readU32(raw, pos);
    pos += 4;
    const comp = raw.subarray(pos, pos + len);
    out.push({ len, comp });
    pos += len;
  }
  return out;
}

function joinOuter(chunks) {
  return Buffer.concat(chunks.map(({ comp }) => {
    const header = Buffer.alloc(4);
    writeU32(header, 0, comp.length);
    return Buffer.concat([header, comp]);
  }));
}

function cryptBody(manifest, buf, size2, direction) {
  const out = Buffer.from(buf);
  for (let p = 0; p + 4 <= out.length; p += 4) {
    const k = keyAt(manifest, size2 + (p >>> 2));
    const v = readU32(out, p);
    writeU32(out, p, direction === "encrypt" ? (v + k) >>> 0 : (v - k) >>> 0);
  }
  return out;
}

function decodePlain(manifest, rec) {
  const fd = fs.openSync(allPath, "r");
  try {
    const raw = Buffer.alloc(rec.size1);
    fs.readSync(fd, raw, 0, raw.length, rec.dataOff);
    const chunks = splitOuter(raw);
    const encryptedBody = Buffer.concat(chunks.map(({ comp }) => snappyRawDecode(comp)));
    return cryptBody(manifest, encryptedBody, rec.size2, "decrypt");
  } finally {
    fs.closeSync(fd);
  }
}

function encodeVarint(value) {
  const out = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function snappyLiteralChunk(data) {
  const pieces = [encodeVarint(data.length)];
  let pos = 0;
  while (pos < data.length) {
    const remaining = data.length - pos;
    const len = Math.min(remaining, 60);
    pieces.push(Buffer.from([((len - 1) << 2) | 0]));
    pieces.push(data.subarray(pos, pos + len));
    pos += len;
  }
  return Buffer.concat(pieces);
}

function rebuildPackedRawSameShape(manifest, rec, editedPlain) {
  if (editedPlain.length !== rec.size2) {
    throw new Error(`Plaintext length changed: ${editedPlain.length} != ${rec.size2}`);
  }
  const encrypted = cryptBody(manifest, editedPlain, rec.size2, "encrypt");
  const existingRaw = fs.readFileSync(allPath).subarray(rec.dataOff, rec.dataOff + rec.size1);
  const chunks = splitOuter(existingRaw);
  const rebuilt = [];
  let pos = 0;
  for (const { comp } of chunks) {
    const decoded = snappyRawDecode(comp);
    const slice = encrypted.subarray(pos, pos + decoded.length);
    pos += decoded.length;
    const repacked = snappyLiteralChunk(slice);
    rebuilt.push({ comp: repacked });
  }
  if (pos !== encrypted.length) throw new Error("Chunk layout mismatch");
  const raw = joinOuter(rebuilt);
  if (raw.length !== rec.size1) {
    throw new Error(`Packed record length changed: ${raw.length} != ${rec.size1}`);
  }
  return raw;
}

function buildFreshPackedRaw(manifest, editedPlain) {
  const encrypted = cryptBody(manifest, editedPlain, editedPlain.length, "encrypt");
  return joinOuter([{ comp: snappyLiteralChunk(encrypted) }]);
}

function getLiveRecord(manifest, name) {
  const records = readAllIndexRecords(manifest);
  const rec = records.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!rec) throw new Error(`Record not found: ${name}`);
  return rec;
}

function patchRecord(recordName, localFile, apply) {
  const manifest = loadManifest();
  const rec = getLiveRecord(manifest, recordName);
  const editedPlain = fs.readFileSync(path.resolve(repoRoot, localFile));
  const originalPlain = decodePlain(manifest, rec);
  console.log(`${rec.name}: original=${originalPlain.length} edited=${editedPlain.length} delta=${editedPlain.length - originalPlain.length}`);

  let rebuilt;
  let mode = "in-place";
  try {
    rebuilt = rebuildPackedRawSameShape(manifest, rec, editedPlain);
  } catch (err) {
    mode = "append";
    rebuilt = buildFreshPackedRaw(manifest, editedPlain);
    console.log(`In-place rebuild unavailable: ${err.message}`);
    console.log(`Insert mode will write a new packed record before the index: size1 ${rec.size1} -> ${rebuilt.length}, size2 ${rec.size2} -> ${editedPlain.length}`);
  }

  const verifyEncrypted = Buffer.concat(splitOuter(rebuilt).map((c) => snappyRawDecode(c.comp)));
  const verifyPlain = cryptBody(manifest, verifyEncrypted, mode === "append" ? editedPlain.length : rec.size2, "decrypt");
  if (!verifyPlain.equals(editedPlain)) throw new Error("Roundtrip verification failed");
  console.log("Roundtrip verification OK.");

  if (!apply) {
    console.log(`Dry run only (${mode} mode). Add --apply to write all.ppp.`);
    return;
  }

  const fd = fs.openSync(allPath, "r+");
  try {
    if (mode === "append") {
      const header = readHeader(manifest);
      const insertOff = header.indexOffset;
      const original = fs.readFileSync(allPath);
      const before = original.subarray(0, insertOff);
      const indexAndTail = original.subarray(insertOff);

      const decodedIndex = Buffer.from(rec.decoded);
      setIndexRecordFields(decodedIndex, {
        dataOff: insertOff,
        size1: rebuilt.length,
        size2: editedPlain.length,
      });
      const encodedIndex = encodeIndexRecord(manifest, decodedIndex, rec.index);

      const newIndexOffset = insertOff + rebuilt.length;
      const decodedHeader = Buffer.from(header.decoded);
      writeU32(decodedHeader, 4, newIndexOffset);
      updateHeaderChecksum(decodedHeader);
      const encodedHeader = encodeHeaderBlock(manifest, decodedHeader);

      const updatedIndexAndTail = Buffer.from(indexAndTail);
      encodedIndex.copy(updatedIndexAndTail, rec.index * (manifest.indexRecordSize ?? 0x99));

      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, before, 0, before.length, 0);
      fs.writeSync(fd, rebuilt, 0, rebuilt.length, before.length);
      fs.writeSync(fd, updatedIndexAndTail, 0, updatedIndexAndTail.length, before.length + rebuilt.length);
      fs.writeSync(fd, encodedHeader, 0, encodedHeader.length, header.headerOffset);
      console.log(`Inserted new packed record at offset ${insertOff} (${rebuilt.length} bytes).`);
      console.log(`Moved index offset ${insertOff} -> ${newIndexOffset}.`);
      console.log(`Updated index record ${rec.index}.`);
    } else {
      fs.writeSync(fd, rebuilt, 0, rebuilt.length, rec.dataOff);
      console.log(`Patched all.ppp at offset ${rec.dataOff} (${rebuilt.length} bytes).`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

try {
  const { cmd, recordName, localFile, flag } = parsed;
  if (!cmd || !recordName || !localFile || !["check", "patch"].includes(cmd)) {
    usage();
    process.exit(cmd ? 1 : 0);
  }
  patchRecord(recordName, localFile, cmd === "patch" && flag === "--apply");
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
