'use strict';
// Recovers sentencepiece.bpe.model from bge_m3_tokenizer.onnx, which ships in
// the same onnx.zip release as the BGE-M3 model. That file is a one-node ONNX
// graph (onnxruntime-extensions' SentencepieceTokenizer op) whose `model`
// attribute IS the serialized sentencepiece model, byte for byte. Extracting
// it means a fresh machine needs nothing from huggingface.co, which is
// unreachable from many networks (the CRM's own notes say it was blocked there).
//
// Verified against the XLM-RoBERTa file the CRM downloads: same size, same
// sha256 (EXPECTED_SHA256 below). We refuse anything else rather than hand the
// workers a tokenizer that would silently produce wrong ids.
const crypto = require('node:crypto');
const fs = require('node:fs');

const EXPECTED_SHA256 = 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865';

// Minimal protobuf reader: yields [fieldNumber, wireType, value] where value
// is a Buffer for length-delimited fields and a Number otherwise.
function* fields(buf) {
  let i = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated protobuf');
      const b = buf[i++];
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) yield [field, wire, varint()];
    else if (wire === 1) { i += 8; yield [field, wire, 0]; }
    else if (wire === 5) { i += 4; yield [field, wire, 0]; }
    else if (wire === 2) {
      const len = varint();
      const start = i;
      i += len;
      if (i > buf.length) throw new Error('truncated protobuf');
      yield [field, wire, buf.subarray(start, i)];
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
}

function extract(tokenizerOnnxPath) {
  const buf = fs.readFileSync(tokenizerOnnxPath);
  for (const [f, w, graph] of fields(buf)) {
    if (f !== 7 || w !== 2) continue; // ModelProto.graph
    for (const [gf, gw, node] of fields(graph)) {
      if (gf !== 1 || gw !== 2) continue; // GraphProto.node
      let opType = '';
      const attrs = [];
      for (const [nf, nw, v] of fields(node)) {
        if (nf === 4 && nw === 2) opType = v.toString('utf8'); // NodeProto.op_type
        if (nf === 5 && nw === 2) attrs.push(v); // NodeProto.attribute
      }
      if (opType !== 'SentencepieceTokenizer') continue;
      for (const attr of attrs) {
        let name = '';
        let bytes = null;
        for (const [af, aw, v] of fields(attr)) {
          if (af === 1 && aw === 2) name = v.toString('utf8'); // AttributeProto.name
          if (af === 4 && aw === 2) bytes = v; // AttributeProto.s
        }
        if (name === 'model' && bytes) return Buffer.from(bytes);
      }
    }
  }
  throw new Error('no SentencepieceTokenizer model found in ' + tokenizerOnnxPath);
}

// Writes the extracted tokenizer to outPath after checking its hash.
function extractTo(tokenizerOnnxPath, outPath) {
  const bytes = extract(tokenizerOnnxPath);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha !== EXPECTED_SHA256) throw new Error(`extracted tokenizer has unexpected sha256 ${sha}`);
  fs.writeFileSync(outPath + '.tmp', bytes);
  fs.renameSync(outPath + '.tmp', outPath);
  return { bytes: bytes.length, sha256: sha };
}

module.exports = { extract, extractTo, EXPECTED_SHA256 };
