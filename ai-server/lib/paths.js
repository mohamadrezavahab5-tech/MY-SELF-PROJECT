'use strict';
// Where the model files live. The layout is exactly the owner's
// crm-companion/scripts/ml/ folder, so MODELS_DIR can point straight at it and
// the gigabytes already downloaded there are reused as they are:
//
//   MODELS_DIR/
//     bge-m3/
//       bge_m3_model.onnx          (graph, ~0.7 MB)
//       bge_m3_model.onnx_data     (weights, ~2.3 GB; loaded automatically from the same folder)
//       sentencepiece.bpe.model    (XLM-RoBERTa tokenizer, ~5 MB)
//       bge_m3_tokenizer.onnx      (optional: from the same onnx.zip; the tokenizer can be extracted from it)
//     reranker/
//       model_quantized.onnx       (bge-reranker-v2-m3, quantized, ~550 MB)
//       config.json                (optional)
const fs = require('node:fs');
const path = require('node:path');

const MODELS_DIR = path.resolve(process.env.MODELS_DIR || path.join(__dirname, '..', 'models'));

const embed = {
  dir: path.join(MODELS_DIR, 'bge-m3'),
  model: path.join(MODELS_DIR, 'bge-m3', 'bge_m3_model.onnx'),
  data: path.join(MODELS_DIR, 'bge-m3', 'bge_m3_model.onnx_data'),
  spm: path.join(MODELS_DIR, 'bge-m3', 'sentencepiece.bpe.model'),
  tokenizerOnnx: path.join(MODELS_DIR, 'bge-m3', 'bge_m3_tokenizer.onnx'),
};

// The quantized file is what the CRM uses; a full-precision export
// (model.onnx + model.onnx.data) also works. RERANKER_FILE picks one explicitly.
function rerankerModelPath() {
  const dir = path.join(MODELS_DIR, 'reranker');
  const names = process.env.RERANKER_FILE ? [process.env.RERANKER_FILE] : ['model_quantized.onnx', 'model.onnx'];
  for (const n of names) {
    const p = path.resolve(dir, n);
    if (fileSize(p) > 0) return p;
  }
  return path.resolve(dir, names[0]);
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// What is missing for each model, as human-readable file names ([] = complete).
function missing() {
  const out = { embeddings: [], reranker: [] };
  if (fileSize(embed.model) < 1024) out.embeddings.push('bge-m3/bge_m3_model.onnx');
  if (fileSize(embed.data) < 1e6 && fileSize(embed.model) < 1e8) out.embeddings.push('bge-m3/bge_m3_model.onnx_data');
  if (fileSize(embed.spm) < 1e5 && fileSize(embed.tokenizerOnnx) < 1e5) out.embeddings.push('bge-m3/sentencepiece.bpe.model');
  const rr = rerankerModelPath();
  if (fileSize(rr) < 1024) out.reranker.push('reranker/' + path.basename(rr));
  if (fileSize(embed.spm) < 1e5 && fileSize(embed.tokenizerOnnx) < 1e5) out.reranker.push('bge-m3/sentencepiece.bpe.model');
  return out;
}

module.exports = { MODELS_DIR, embed, rerankerModelPath, fileSize, missing };
