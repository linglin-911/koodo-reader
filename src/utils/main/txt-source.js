const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const CONTRACT = Object.freeze({ parserVersion: 1, indexVersion: 1, normalizationVersion: 1, featureVersion: 1 });
const SAMPLE_ALGORITHM = "sha256-3x4096-v1";
const resolveSource = (c) => {
  const library = path.join(c.storagePath, "book", c.bookId + ".txt");
  const selected = fs.existsSync(library) ? library : c.bookPath;
  if (!selected) throw new Error("TXT source is unavailable");
  return fs.realpathSync.native(selected);
};
const statIdentity = (file, stat) => {
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid TXT source file");
  return {
    realpath: file,
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
};
const sample = (size, read) => {
  const hash = crypto.createHash("sha256");
  const offsets = [
    ...new Set([
      0,
      Math.max(0, Math.floor(size / 2) - 2048),
      Math.max(0, size - 4096),
    ]),
  ];
  for (const start of offsets) {
    const length = Math.min(4096, size - start);
    hash.update(`${start}:${length}:`);
    hash.update(read(start, length));
  }
  return hash.digest("hex");
};
const encodingOf = (bytes, charset) => {
  let encoding = new TextDecoder(charset || "utf-8").encoding;
  let bomBytes = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = "utf-8";
    bomBytes = 3;
  } else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    bomBytes = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    bomBytes = 2;
  }
  return { encoding, bomBytes };
};
// Sampling is a lightweight change detector, never a complete content proof.
const inspect = (c) => {
  const file = resolveSource(c);
  const fd = fs.openSync(file, "r");
  try {
    const identity = statIdentity(file, fs.fstatSync(fd, { bigint: true }));
    const read = (start, length) => {
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const count = fs.readSync(
          fd,
          buffer,
          total,
          length - total,
          start + total
        );
        if (!count) throw new Error("TXT file changed during read");
        total += count;
      }
      return buffer;
    };
    const sampleFingerprint = sample(identity.size, read);
    const encoding = encodingOf(read(0, Math.min(4, identity.size)), c.charset);
    // Inspection remains bounded. Cold source data is read only through the
    // explicit read-source operation, after the SQLite cache has been checked.
    const after = statIdentity(file, fs.fstatSync(fd, { bigint: true }));
    const currentFile = resolveSource(c);
    // Electron's patched statSync can report dev=0 on Windows; use fstat for
    // both descriptors so volume/inode comparisons use the same native API.
    const currentFd = fs.openSync(currentFile, "r");
    let current;
    try {
      current = statIdentity(
        currentFile,
        fs.fstatSync(currentFd, { bigint: true })
      );
    } finally {
      fs.closeSync(currentFd);
    }
    if (
      JSON.stringify(identity) !== JSON.stringify(after) ||
      JSON.stringify(identity) !== JSON.stringify(current)
    )
      throw new Error(
        "TXT changed during inspection: " +
          Object.keys(identity)
            .filter(
              (key) =>
                identity[key] !== after[key] || identity[key] !== current[key]
            )
            .join(",")
      );
    const metadata = {
      identity,
      ...encoding,
      sampleFingerprint,
      sampleAlgorithm: SAMPLE_ALGORITHM,
      contract: CONTRACT,
      configDigest: crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            parserRegex: c.parserRegex || "",
            charset: c.charset || "",
          })
        )
        .digest("hex"),
    };
    return { metadata };
  } finally {
    fs.closeSync(fd);
  }
};
const readVerifiedRange = (request, metadata, start, length) => {
  const fd = fs.openSync(metadata.identity.realpath, "r");
  try {
    const sameIdentity = (stat) =>
      JSON.stringify(statIdentity(metadata.identity.realpath, stat)) ===
      JSON.stringify(metadata.identity);
    if (!sameIdentity(fs.fstatSync(fd, { bigint: true })))
      throw new Error("TXT source changed; reopen before reading");
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const count = fs.readSync(
        fd,
        buffer,
        total,
        length - total,
        start + total
      );
      if (!count) throw new Error("TXT source changed during range read");
      total += count;
    }
    if (
      !sameIdentity(fs.fstatSync(fd, { bigint: true })) ||
      JSON.stringify(inspect(request).metadata) !== JSON.stringify(metadata)
    ) {
      throw new Error("TXT source changed during range read");
    }
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
};

const resolveSourceAsync = async c => {
  const library = path.join(c.storagePath, "book", c.bookId + ".txt");
  let selected = library;
  try { await fs.promises.access(library); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    selected = c.bookPath;
  }
  if (!selected) throw Error("TXT source is unavailable");
  return fs.promises.realpath(selected);
};
const readExactly = async (fd, start, length) => {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await fd.read(buffer, total, length - total, start + total);
    if (!bytesRead) throw Error("TXT source changed during read");
    total += bytesRead;
  }
  return buffer;
};
const inspectAsync = async c => {
  const file = await resolveSourceAsync(c), fd = await fs.promises.open(file, "r");
  try {
    const identity = statIdentity(file, await fd.stat({ bigint: true }));
    const hash = crypto.createHash("sha256");
    for (const start of new Set([0, Math.max(0, Math.floor(identity.size / 2) - 2048), Math.max(0, identity.size - 4096)])) {
      const length = Math.min(4096, identity.size - start);
      hash.update(`${start}:${length}:`); hash.update(await readExactly(fd, start, length));
    }
    const encoding = encodingOf(await readExactly(fd, 0, Math.min(4, identity.size)), c.charset);
    const after = statIdentity(file, await fd.stat({ bigint: true }));
    const currentFile = await resolveSourceAsync(c), currentFd = await fs.promises.open(currentFile, "r");
    let current;
    try { current = statIdentity(currentFile, await currentFd.stat({ bigint: true })); } finally { await currentFd.close(); }
    if (JSON.stringify(identity) !== JSON.stringify(after) || JSON.stringify(identity) !== JSON.stringify(current)) throw Error("TXT changed during inspection");
    return { metadata: { identity, ...encoding, sampleFingerprint: hash.digest("hex"), sampleAlgorithm: SAMPLE_ALGORITHM,
      contract: CONTRACT, configDigest: crypto.createHash("sha256").update(JSON.stringify({ parserRegex: c.parserRegex || "", charset: c.charset || "" })).digest("hex") } };
  } finally { await fd.close(); }
};
const readVerifiedRangeAsync = async (request, metadata, start, length) => {
  if (JSON.stringify((await inspectAsync(request)).metadata) !== JSON.stringify(metadata)) throw Error("TXT source changed; reopen before reading");
  const fd = await fs.promises.open(metadata.identity.realpath, "r");
  const same = stat => JSON.stringify(statIdentity(metadata.identity.realpath, stat)) === JSON.stringify(metadata.identity);
  try {
    if (!same(await fd.stat({ bigint: true }))) throw Error("TXT source changed; reopen before reading");
    const buffer = await readExactly(fd, start, length);
    if (!same(await fd.stat({ bigint: true })) || JSON.stringify((await inspectAsync(request)).metadata) !== JSON.stringify(metadata)) throw Error("TXT source changed during range read");
    return buffer;
  } finally { await fd.close(); }
};
module.exports = { inspect, inspectAsync, readVerifiedRange, readVerifiedRangeAsync, readExactly, statIdentity };
