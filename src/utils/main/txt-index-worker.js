const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs"), crypto = require("node:crypto");
const { scanTxtStream } = require("./txt-scanner.cjs");
const { inspectAsync, statIdentity } = require("./txt-source");
let acknowledgement;
parentPort.on("message", message => { if (message === "ack" && acknowledgement) { const resolve = acknowledgement; acknowledgement = null; resolve(); } });
const send = message => new Promise(resolve => { acknowledgement = resolve; parentPort.postMessage(message); });
(async () => {
  const { request, metadata } = workerData;
  const same = actual => JSON.stringify(actual) === JSON.stringify(metadata);
  if (!same((await inspectAsync(request)).metadata)) throw Error("TXT source changed before scan");
  const fd = await fs.promises.open(metadata.identity.realpath, "r");
  const fullHash=crypto.createHash("sha256");
  let batch = [], batchBytes = 0, readBytes = 0, lastProgress = 0;
  const flush = async () => { if (batch.length) { await send({ type: "batch", rows: batch }); batch = []; batchBytes = 0; } };
  try {
    if(metadata.bomBytes){const bom=Buffer.alloc(metadata.bomBytes);const result=await fd.read(bom,0,bom.length,0);if(result.bytesRead!==bom.length)throw Error("TXT source truncated during scan");fullHash.update(bom);}
    if (JSON.stringify(statIdentity(metadata.identity.realpath, await fd.stat({ bigint: true }))) !== JSON.stringify(metadata.identity)) throw Error("TXT source changed before scan");
    async function* chunks() {
      let position = metadata.bomBytes;
      while (position < metadata.identity.size) {
        const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, metadata.identity.size - position));
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw Error("TXT source truncated during scan");
        position += bytesRead; readBytes += bytesRead;
        fullHash.update(buffer.subarray(0,bytesRead));
        yield buffer.subarray(0, bytesRead);
        if (Date.now() - lastProgress > 100) {
          parentPort.postMessage({ type: "progress", bytes: position }); lastProgress = Date.now();
        }
      }
    }
    const header = await scanTxtStream(chunks(), { encoding: metadata.encoding, bomBytes: metadata.bomBytes,
      byteLength: metadata.identity.size, parserRegex: request.parserRegex, id: crypto.randomUUID,
      onHeadings: async () => { await flush(); await send({ type: "reset" }); },
      onChapter: async chapter => {
        const size = chapter.label.length * 2 + 512;
        if (batch.length >= 128 || batchBytes + size > 256 * 1024) await flush();
        batch.push(chapter); batchBytes += size;
        // Publish the first finalized range promptly for the temporary preview.
        if (chapter.index === 0) await flush();
      } });
    await flush();
    if (JSON.stringify(statIdentity(metadata.identity.realpath, await fd.stat({ bigint: true }))) !== JSON.stringify(metadata.identity) || !same((await inspectAsync(request)).metadata)) throw Error("TXT source changed during scan");
    parentPort.postMessage({ type: "done", header:{...header,fullHash:{algorithm:"sha256",digest:fullHash.digest("hex"),bytes:metadata.identity.size}}, readBytes });
  } finally { await fd.close(); }
})().catch(error => parentPort.postMessage({ type: "error", message: error.message })).finally(() => parentPort.close());
