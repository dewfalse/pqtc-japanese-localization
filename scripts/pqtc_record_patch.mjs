import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(import.meta.dirname, "pqtc_text_manifest.json");
let allPath = path.join(root, "all.ppp");

function usage() {
  console.log([
    "Usage:",
    '  node tools/pqtc_record_patch.mjs patch "<recordName>" "<localFile>" [--apply]',
    '  node tools/pqtc_record_patch.mjs check "<recordName>" "<localFile>"',
    '  node tools/pqtc_record_patch.mjs patch --game-dir "<PQTC dir>" "<recordName>" "<localFile>" [--apply]',
    '  node tools/pqtc_record_patch.mjs check --game-dir "<PQTC dir>" "<recordName>" "<localFile>"',
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

  return {
    cmd,
    recordName,
    localFile,
    flag,
    gameDir: gameDir ? path.resolve(gameDir) : root,
  };
}

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
  const size2 = fields.size2 >>> 0;
  decoded[0x97] = size2 & 0xff;
  decoded[0x91] = (size2 >>> 8) & 0xff;
  decoded[0x95] = (size2 >>> 16) & 0xff;
  decoded[0x93] = (size2 >>> 24) & 0xff;
  const size1 = fields.size1 >>> 0;
  decoded[0x94] = size1 & 0xff;
  decoded[0x96] = (size1 >>> 8) & 0xff;
  decoded[0x92] = (size1 >>> 16) & 0xff;
  decoded[0x98] = (size1 >>> 24) & 0xff;
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
  const start = state.pos;
  for (;;) {
    if (state.pos >= buf.length) throw new Error("Truncated varint");
    const c = buf[state.pos++];
    value |= (c & 0x7f) << shift;
    if (c < 0x80) return { value: value >>> 0, start, end: state.pos };
    shift += 7;
    if (shift > 28) throw new Error("Varint too long");
  }
}

function writeVarint(value) {
  const out = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function snappyRawDecode(comp) {
  const state = { pos: 0 };
  const { value: outLen } = readVarint(comp, state);
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
        for (let i = 0; i < n; i++) {
          if (state.pos >= comp.length) throw new Error("Truncated literal length");
          len |= comp[state.pos++] << (8 * i);
        }
        len += 1;
      }
      if (state.pos + len > comp.length) throw new Error("Truncated literal data");
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
    if (off <= 0 || op < off) throw new Error("Invalid copy offset");
    for (let i = 0; i < len; i++) out[op + i] = out[op - off + i];
    op += len;
  }
  if (op !== outLen) throw new Error(`Snappy length mismatch: ${op} != ${outLen}`);
  return out;
}

function writeSnappyLiteral(data) {
  const lenMinusOne = data.length - 1;
  if (data.length <= 0) throw new Error("Cannot encode empty Snappy literal chunk");
  let literalHeader;
  if (lenMinusOne < 60) {
    literalHeader = Buffer.from([lenMinusOne << 2]);
  } else {
    const lenBytes = [];
    let n = lenMinusOne;
    while (n > 0) {
      lenBytes.push(n & 0xff);
      n >>>= 8;
    }
    literalHeader = Buffer.from([(59 + lenBytes.length) << 2, ...lenBytes]);
  }
  return Buffer.concat([writeVarint(data.length), literalHeader, data]);
}

function parseSnappyCommands(comp) {
  const state = { pos: 0 };
  const header = readVarint(comp, state);
  const commands = [];
  while (state.pos < comp.length) {
    const start = state.pos;
    const tag = comp[state.pos++];
    const type = tag & 3;
    if (type === 0) {
      let lenCode = tag >>> 2;
      let len;
      const lenBytes = [];
      if (lenCode < 60) {
        len = lenCode + 1;
      } else {
        const n = lenCode - 59;
        len = 0;
        for (let i = 0; i < n; i++) {
          const b = comp[state.pos++];
          lenBytes.push(b);
          len |= b << (8 * i);
        }
        len += 1;
      }
      commands.push({ type: "literal", len, header: comp.subarray(start, state.pos) });
      state.pos += len;
    } else if (type === 1) {
      const len = ((tag >>> 2) & 7) + 4;
      state.pos += 1;
      commands.push({ type: "copy", len, encoded: comp.subarray(start, state.pos) });
    } else if (type === 2) {
      const len = (tag >>> 2) + 1;
      state.pos += 2;
      commands.push({ type: "copy", len, encoded: comp.subarray(start, state.pos) });
    } else {
      const len = (tag >>> 2) + 1;
      state.pos += 4;
      commands.push({ type: "copy", len, encoded: comp.subarray(start, state.pos) });
    }
  }
  return { outLen: header.value, varint: comp.subarray(header.start, header.end), commands };
}

function rebuildChunkWithSameCommands(originalComp, desiredPlainEncrypted) {
  const parsed = parseSnappyCommands(originalComp);
  if (parsed.outLen !== desiredPlainEncrypted.length) {
    throw new Error(`Chunk output length changed: ${desiredPlainEncrypted.length} != ${parsed.outLen}`);
  }
  const parts = [parsed.varint];
  let op = 0;
  for (const cmd of parsed.commands) {
    if (cmd.type === "literal") {
      parts.push(cmd.header, desiredPlainEncrypted.subarray(op, op + cmd.len));
      op += cmd.len;
    } else {
      parts.push(cmd.encoded);
      op += cmd.len;
    }
  }
  return Buffer.concat(parts);
}

function splitOuter(raw) {
  const chunks = [];
  let pos = 0;
  while (pos < raw.length) {
    const len = readU32(raw, pos);
    pos += 4;
    chunks.push({ comp: raw.subarray(pos, pos + len) });
    pos += len;
  }
  return chunks;
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

function readPackedRaw(rec) {
  const fd = fs.openSync(allPath, "r");
  try {
    const buf = Buffer.alloc(rec.size1);
    fs.readSync(fd, buf, 0, buf.length, rec.dataOff);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function decodePlain(manifest, rec) {
  const raw = readPackedRaw(rec);
  const chunks = splitOuter(raw);
  const encryptedBody = Buffer.concat(chunks.map((c) => snappyRawDecode(c.comp)));
  return cryptBody(manifest, encryptedBody, rec.size2, "decrypt");
}

function rebuildPackedRawSameShape(manifest, rec, editedPlain) {
  if (editedPlain.length !== rec.size2) {
    throw new Error(`Edited byte length must stay ${rec.size2}, got ${editedPlain.length}`);
  }
  const originalRaw = readPackedRaw(rec);
  const originalChunks = splitOuter(originalRaw);
  const encryptedBody = cryptBody(manifest, editedPlain, rec.size2, "encrypt");
  let bodyPos = 0;
  const parts = [];
  for (const chunk of originalChunks) {
    const outLen = parseSnappyCommands(chunk.comp).outLen;
    const encryptedChunk = encryptedBody.subarray(bodyPos, bodyPos + outLen);
    bodyPos += outLen;
    const rebuiltComp = rebuildChunkWithSameCommands(chunk.comp, encryptedChunk);
    const header = Buffer.alloc(4);
    writeU32(header, 0, rebuiltComp.length);
    parts.push(header, rebuiltComp);
  }
  const rebuilt = Buffer.concat(parts);
  if (rebuilt.length !== rec.size1) {
    throw new Error(`Packed record length changed: ${rebuilt.length} != ${rec.size1}`);
  }
  return rebuilt;
}

function buildFreshPackedRaw(manifest, editedPlain) {
  const encryptedBody = cryptBody(manifest, editedPlain, editedPlain.length, "encrypt");
  const chunks = [];
  for (let pos = 0; pos < encryptedBody.length; pos += 0x2800) {
    const plainChunk = encryptedBody.subarray(pos, Math.min(encryptedBody.length, pos + 0x2800));
    const comp = writeSnappyLiteral(plainChunk);
    const header = Buffer.alloc(4);
    writeU32(header, 0, comp.length);
    chunks.push(header, comp);
  }
  return Buffer.concat(chunks);
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
  const editedPlain = fs.readFileSync(path.resolve(root, localFile));
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
  const { cmd, recordName, localFile, flag, gameDir } = parseArgs(process.argv.slice(2));
  if (!cmd || !recordName || !localFile || !["check", "patch"].includes(cmd)) {
    usage();
    process.exit(cmd ? 1 : 0);
  }
  allPath = path.join(gameDir, "all.ppp");
  patchRecord(recordName, localFile, cmd === "patch" && flag === "--apply");
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}
