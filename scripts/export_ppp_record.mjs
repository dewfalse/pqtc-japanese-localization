import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(import.meta.dirname, 'pqtc_text_manifest.json');
const allPath = path.join(root, 'all.ppp');
const extractedRoot = path.join(root, 'extracted_texts');

function loadManifest() {
	return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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

function readHeader(manifest) {
	const headerOffset = manifest.headerOffset ?? 0xe5;
	const fd = fs.openSync(allPath, 'r');
	try {
		const encrypted = Buffer.alloc(16);
		fs.readSync(fd, encrypted, 0, encrypted.length, headerOffset);
		const decoded = decodeHeaderBlock(manifest, encrypted);
		return {
			fileNum: readU32(decoded, 0),
			indexOffset: readU32(decoded, 4),
		};
	} finally {
		fs.closeSync(fd);
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

function indexRecordName(decoded) {
	let end = decoded.indexOf(0, 8);
	if (end < 0 || end > 0x88) end = 0x88;
	return decoded.subarray(8, end).toString('utf8');
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

function readAllIndexRecords(manifest) {
	const header = readHeader(manifest);
	const recSize = manifest.indexRecordSize ?? 0x99;
	const fd = fs.openSync(allPath, 'r');
	try {
		const out = [];
		for (let i = 0; i < header.fileNum; i++) {
			const raw = Buffer.alloc(recSize);
			fs.readSync(fd, raw, 0, recSize, header.indexOffset + i * recSize);
			const decoded = decodeIndexRecord(manifest, raw, i);
			out.push({
				index: i,
				name: indexRecordName(decoded),
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
		if (state.pos >= buf.length) throw new Error('Truncated varint');
		const c = buf[state.pos++];
		value |= (c & 0x7f) << shift;
		if (c < 0x80) return value >>> 0;
		shift += 7;
		if (shift > 28) throw new Error('Varint too long');
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
	const chunks = [];
	let pos = 0;
	while (pos < raw.length) {
		const len = readU32(raw, pos);
		pos += 4;
		chunks.push(raw.subarray(pos, pos + len));
		pos += len;
	}
	return chunks;
}

function cryptTextBody(manifest, buf, size2) {
	const out = Buffer.from(buf);
	for (let p = 0; p + 4 <= out.length; p += 4) {
		const k = keyAt(manifest, size2 + (p >>> 2));
		writeU32(out, p, (readU32(out, p) - k) >>> 0);
	}
	return out;
}

function isPng(buf) {
	return buf.length >= 8
		&& buf[0] === 0x89
		&& buf[1] === 0x50
		&& buf[2] === 0x4e
		&& buf[3] === 0x47
		&& buf[4] === 0x0d
		&& buf[5] === 0x0a
		&& buf[6] === 0x1a
		&& buf[7] === 0x0a;
}

function usesRawPackedBody(recordName, expandedBody) {
	return /\.png$/i.test(recordName) && isPng(expandedBody);
}

function decodePlain(manifest, rec) {
	const fd = fs.openSync(allPath, 'r');
	try {
		const raw = Buffer.alloc(rec.size1);
		fs.readSync(fd, raw, 0, raw.length, rec.dataOff);
		const chunks = splitOuter(raw);
		const encryptedBody = Buffer.concat(chunks.map((comp) => snappyRawDecode(comp)));
		if (usesRawPackedBody(rec.name, encryptedBody)) return encryptedBody;
		return cryptTextBody(manifest, encryptedBody, rec.size2);
	} finally {
		fs.closeSync(fd);
	}
}

function outPathFor(name) {
	return path.join(extractedRoot, ...name.split('\\'));
}

const names = process.argv.slice(2);
if (names.length === 0) {
	console.error('Usage: node tools/export_ppp_record.mjs <recordName> [...]');
	process.exit(1);
}

const manifest = loadManifest();
const all = readAllIndexRecords(manifest);
const byName = new Map(all.map((r) => [r.name, r]));

for (const name of names) {
	const rec = byName.get(name);
	if (!rec) {
		console.error(`Missing record: ${name}`);
		continue;
	}
	const plain = decodePlain(manifest, rec);
	const outPath = outPathFor(name);
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, plain);
	console.log(`EXPORTED\t${rec.index}\t${name}\t${outPath}`);
}
