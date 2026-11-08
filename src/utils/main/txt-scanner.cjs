'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

const TXT_BLOCK_BYTES = 8192;
function prefix(bytes, encoding, final) {
    const stride = encoding.startsWith("utf-16") ? 2 : 1;
    let end = Math.min(TXT_BLOCK_BYTES, bytes.length);
    end -= end % stride;
    // Prefer a paragraph boundary, with a hard limit even for a single long line.
    if (!final || end < bytes.length) {
        for (let i = end - stride; i >= TXT_BLOCK_BYTES / 2; i -= stride) {
            const value = stride === 1 ? bytes[i] : encoding === "utf-16le"
                ? bytes[i] | bytes[i + 1] << 8 : bytes[i] << 8 | bytes[i + 1];
            if (value === 10) {
                end = i + stride;
                break;
            }
        }
    }
    for (let attempts = 0; attempts < 5 && end > 0; attempts++, end -= stride) {
        try {
            const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, end));
            // Never split CRLF, including a CR precisely on the physical block edge.
            if (text.endsWith("\r") && !(final && end === bytes.length)) {
                end -= stride;
                continue;
            }
            return { end, text };
        }
        catch { /* A multibyte character or UTF-16 surrogate pair crosses the edge. */ }
    }
    throw Error("Invalid TXT block encoding");
}
/** Buffer size is independent of book, chapter, paragraph and upstream chunk size. */
async function* checkpointTxtStream(chunks, encoding, bomBytes, points) {
    const pending = new Uint8Array(TXT_BLOCK_BYTES + 4);
    let used = 0, offset = bomBytes, count = 0;
    points.push([offset, 0]);
    const take = (final) => {
        const part = prefix(pending.subarray(0, used), encoding, final);
        const bytes = pending.slice(0, part.end);
        pending.copyWithin(0, part.end, used);
        used -= part.end;
        offset += part.end;
        count += part.text.replace(/\r\n?/g, "\n").length;
        points.push([offset, count]);
        return bytes;
    };
    for await (const chunk of chunks) {
        for (let i = 0; i < chunk.length;) {
            const size = Math.min(pending.length - used, chunk.length - i);
            pending.set(chunk.subarray(i, i + size), used);
            used += size;
            i += size;
            if (used === pending.length)
                yield take(false);
        }
    }
    while (used)
        yield take(true);
}

let keywords = [
    "章",
    "节",
    "回",
    "節",
    "卷",
    "部",
    "輯",
    "辑",
    "話",
    "集",
    "话",
    "篇",
    " ",
    "　",
];
let containChars = [];
// let containChars = ["[", "。", "；", ";"];
let startWithChars = [
    "CHAPTER",
    "Chapter",
    "序章",
    "前言",
    "声明",
    "写在前面的话",
    "后记",
    "楔子",
    "后序",
    "章节目录",
    "尾声",
    "聲明",
    "引子",
    "序言",
    "题记",
    "开篇",
    "开篇词",
    "卷首",
    "卷首语",
    "引言",
    "导言",
    "入话",
    "作者的话",
    "写在前面",
    "重要声明",
    "免责声明",
    "版权声明",
    "致读者",
    "特别说明",
    "终章",
    "大结局",
    "完结感言",
    "完结篇",
    "写在后面的话",
    "作者有话说",
    "感言",
    "番外",
    "番外篇",
    "外传",
    "特别篇",
    "特别篇目",
    "附录",
    "小剧场",
    "彩蛋",
    "寫在前面的話",
    "後記",
    "後序",
    "章節目錄",
    "尾聲",
    "題記",
    "開篇",
    "開篇詞",
    "卷首語",
    "導言",
    "入話",
    "作者的話",
    "寫在前面",
    "重要聲明",
    "免責聲明",
    "版權聲明",
    "致讀者",
    "特別說明",
    "終章",
    "大結局",
    "完結感言",
    "完結篇",
    "寫在後面的話",
    "作者有話說",
    "外傳",
    "特別篇",
    "特別篇目",
    "附錄",
    "小劇場",
];
const cleanText = (str) => {
    return str
        .trim()
        .replace(/(\r\n|\n|\r|\t)/gm, "")
        .substring(0, 100)
        .split("")
        .filter((item) => item !== "=" && item !== "-" && item !== "_" && item !== "+")
        .join("");
};
const isTitle = (line, parserRegex = "") => {
    if (parserRegex) {
        return new RegExp(parserRegex).test(line);
    }
    line = cleanText(line); // Clean once per line
    return (line &&
        line.length < 50 &&
        !isContain(line) &&
        (isStartWithChars(line) ||
            (line.startsWith("第") && startWithDI(line)) ||
            (line.startsWith("卷") && startWithJUAN(line)) ||
            (line.indexOf("第") > -1 &&
                line.lastIndexOf("第") < 7 &&
                startWithDI(line.substr(line.indexOf("第"))))));
};
const isContain = (line) => {
    return containChars.filter((item) => line.indexOf(item) > -1).length > 0;
};
const isStartWithChars = (line) => {
    return startWithChars.filter((item) => line.startsWith(item)).length > 0;
};
const startWithDI = (line) => {
    let flag = false;
    for (let i = 0; i < keywords.length; i++) {
        if (/^[\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u4ebf\u5146\u5eff\u5345\u62fe\u4f70\u4edf\u58f9\u8d30\u53c1\u8086\u4f0d\u9646\u67d2\u634c\u7396\u4e24\u842c\u5169]+$/.test(line.substring(1, line.indexOf(keywords[i])).trim()) ||
            /^\d+$/.test(line.substring(1, line.indexOf(keywords[i])).trim())) {
            flag = true;
        }
        if (flag)
            break;
    }
    return flag;
};
const startWithJUAN = (line) => {
    let regExp = /^[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u842c\u96f6]+$/;
    if (regExp.test(line.substring(1, line.indexOf(" "))) ||
        /^\d+$/.test(line.substring(1, line.indexOf(" "))))
        return true;
    if (regExp.test(line.substring(1, line.indexOf("　"))) ||
        /^\d+$/.test(line.substring(1, line.indexOf("　"))))
        return true;
    if (regExp.test(line.substring(1, line.indexOf("·"))) ||
        /^\d+$/.test(line.substring(1, line.indexOf("·"))))
        return true;
    if (regExp.test(line.substring(1)) || /^\d+$/.test(line.substring(1)))
        return true;
    return false;
};

const TXT_INDEX_CONTRACT = {
    parserVersion: 1,
    indexVersion: 1,
    normalizationVersion: 1,
    featureVersion: 1,
};

const tail = (a, b) => Array.from(a + b).slice(-2).join("");
const section = (line) => ({ first: line, end: line, lines: 1, firstChars: line.first, tail: line.tail });
const append = (a, b) => {
    a.end = b.end;
    a.lines += b.lines;
    if (!a.firstChars)
        a.firstChars = b.firstChars;
    a.tail = tail(a.tail, b.tail);
};
/** Single physical pass. Retains bounded line probes and section summaries, never
 * a book/chapter string or an array of all chapter metadata. Custom regexes have
 * an explicit 64K UTF-16 line limit; a Worker watchdog handles pathological CPU. */
async function scanTxtStream(chunks, options) {
    const { encoding, bomBytes, byteLength } = options;
    const regex = options.parserRegex ? new RegExp(options.parserRegex) : null;
    const stride = encoding.startsWith("utf-16") ? 2 : 1;
    const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true });
    let offset = bomBytes, textStart = 0, byteStart = bomBytes, length = 0;
    let raw = "", probe = "", trimmedLength = 0, leading = true, first = "", last = "";
    let probeLength = 0, probeMeaningfulLength = 0;
    let nonLeadingLength = 0, pendingCR = null, carry = new Uint8Array();
    let content = false, lineCount = 0, count = 0, headings = false;
    let current = null, candidate = null;
    let fallback = null, fallbackIndex = 0;
    const readText = (text) => {
        length += text.length;
        if (regex && length > 65536)
            throw Error("TXT custom parser line exceeds 65536 UTF-16 units");
        if (regex)
            raw += text;
        const significant = leading ? text.trimStart() : text;
        if (!significant)
            return;
        leading = false;
        if (!regex && raw.length < 65536)
            raw += significant.slice(0, 65536 - raw.length);
        const noTabs = significant.replace(/\t/g, "");
        if (probe.length < 100)
            probe += noTabs.slice(0, 100 - probe.length);
        const cleanEnd = noTabs.trimEnd().length;
        if (cleanEnd)
            probeMeaningfulLength = probeLength + cleanEnd;
        probeLength += noTabs.length;
        const trimmed = significant.trimEnd();
        if (trimmed) {
            trimmedLength = nonLeadingLength + trimmed.length;
            if (Array.from(first).length < 2) {
                for (const point of significant) {
                    if (!/\s/u.test(point))
                        first += point;
                    if (Array.from(first).length === 2)
                        break;
                }
            }
            const points = [];
            for (let end = trimmed.length; end > 0 && points.length < 2;) {
                const code = trimmed.charCodeAt(end - 1);
                const start = code >= 0xdc00 && code <= 0xdfff && end > 1 &&
                    trimmed.charCodeAt(end - 2) >= 0xd800 && trimmed.charCodeAt(end - 2) <= 0xdbff ? end - 2 : end - 1;
                const point = trimmed.slice(start, end);
                if (!/\s/u.test(point))
                    points.unshift(point);
                end = start;
            }
            last = tail(last, points.join(""));
        }
        nonLeadingLength += significant.length;
    };
    const emit = async (part, hasTitle, fixed, body) => {
        const label = fixed ? `Chapter ${fallbackIndex++}` : hasTitle ? part.first.label : "";
        const start = part.first.start, end = part.end.end, lines = part.lines;
        const chapter = {
            index: count++, chapterId: options.id(), label, start, end,
            byteStart: part.first.byteStart, byteEnd: part.end.byteEnd,
            bodyStart: hasTitle ? part.first.next : start,
            bodyByteStart: hasTitle ? part.first.byteNext : part.first.byteStart,
            firstChars: hasTitle ? body?.firstChars || "" : part.firstChars,
            lastChars: hasTitle ? body?.tail || "" : part.tail,
            lineCount: lines, hasTitle, fixedChunk: fixed,
            recognition: fixed ? "fixed" : hasTitle ? "heading" : "preamble",
            size: Math.max(1, end - start - Math.max(0, lines - 1) + lines * 7 + (hasTitle ? 2 : 0) + (fixed ? 22 + label.length : 0)),
        };
        await options.onChapter(chapter);
    };
    let body = null;
    const process = async (line) => {
        if (!content && line.blank)
            return;
        content = true;
        lineCount++;
        const one = section(line);
        if (!headings) {
            if (!fallback)
                fallback = section(line);
            else
                append(fallback, section(line));
            if (fallback.lines === 500) {
                await emit(fallback, false, true);
                fallback = null;
            }
        }
        if (line.title) {
            // Empty heading candidates become ordinary body lines.
            if (candidate) {
                if (current)
                    append(current, candidate);
                else
                    current = candidate;
                if (headings) {
                    if (body)
                        append(body, candidate);
                    else
                        body = { ...candidate };
                }
            }
            candidate = one;
        }
        else if (candidate) {
            append(candidate, one);
            if (!line.blank) {
                if (!headings) {
                    await options.onHeadings();
                    count = 0;
                    headings = true;
                    fallback = null;
                }
                if (current)
                    await emit(current, !!body, false, body || undefined);
                current = candidate;
                // Candidate consists of title, blank lines, and this first nonblank body.
                body = section(line);
                // Blank lines still count toward section length but not body features.
                candidate = null;
            }
        }
        else {
            if (current)
                append(current, one);
            else
                current = one;
            if (headings) {
                if (body)
                    append(body, section(line));
                else
                    body = section(line);
            }
        }
    };
    const finishLine = async (end, newlineBytes) => {
        readText(decoder.decode());
        let title = false, label = "";
        if (regex) {
            regex.lastIndex = 0;
            title = !!raw && regex.test(raw);
            label = raw.trim();
        }
        else {
            // Appending a sentinel preserves whitespace inside a long probe when
            // cleanText trims it before taking the first 100 units.
            title = !!trimmedLength && !!isTitle(probe + (probeMeaningfulLength > 100 ? "x" : ""));
            if (title && trimmedLength > 65536)
                throw Error("TXT chapter title exceeds 65536 UTF-16 units");
            label = raw.slice(0, trimmedLength).trim();
        }
        const line = { start: textStart, end: textStart + length, byteStart, byteEnd: end,
            next: textStart + length + (newlineBytes ? 1 : 0), byteNext: end + newlineBytes,
            title, label, first, tail: last, blank: !trimmedLength };
        await process(line);
        textStart = line.next;
        byteStart = line.byteNext;
        length = 0;
        raw = "";
        probe = "";
        probeLength = 0;
        probeMeaningfulLength = 0;
        trimmedLength = 0;
        nonLeadingLength = 0;
        leading = true;
        first = "";
        last = "";
    };
    const checkpoints = [];
    for await (let chunk of checkpointTxtStream(chunks, encoding, bomBytes, checkpoints)) {
        if (carry.length) {
            const joined = new Uint8Array(carry.length + chunk.length);
            joined.set(carry);
            joined.set(chunk, carry.length);
            chunk = joined;
        }
        const usable = chunk.length - chunk.length % stride;
        carry = chunk.slice(usable);
        chunk = chunk.subarray(0, usable);
        let segment = 0;
        for (let i = 0; i < chunk.length; i += stride) {
            const value = stride === 1 ? chunk[i] : encoding === "utf-16le" ? chunk[i] | chunk[i + 1] << 8 : chunk[i] << 8 | chunk[i + 1];
            if (pendingCR !== null) {
                await finishLine(pendingCR, stride * (value === 10 ? 2 : 1));
                pendingCR = null;
                if (value === 10) {
                    segment = i + stride;
                    continue;
                }
            }
            if (value === 10 || value === 13) {
                readText(decoder.decode(chunk.subarray(segment, i), { stream: true }));
                if (value === 13)
                    pendingCR = offset + i;
                else
                    await finishLine(offset + i, stride);
                segment = i + stride;
            }
        }
        readText(decoder.decode(chunk.subarray(segment), { stream: true }));
        offset += chunk.length;
    }
    if (carry.length || offset !== byteLength)
        throw Error("Incomplete TXT byte stream");
    if (pendingCR !== null)
        await finishLine(pendingCR, stride);
    await finishLine(byteLength, 0);
    if (candidate && current) {
        append(current, candidate);
        if (body)
            append(body, candidate);
    }
    else if (candidate)
        current = candidate;
    if (headings) {
        if (current)
            await emit(current, true, false, body || undefined);
    }
    else if (fallback)
        await emit(fallback, false, true);
    else if (!content) {
        const empty = { start: textStart, end: textStart, byteStart: byteLength, byteEnd: byteLength,
            next: textStart, byteNext: byteLength, label: "", title: false, first: "", tail: "", blank: true };
        const part = section(empty);
        part.lines = 0;
        await emit(part, false, true);
    }
    return { checkpoints, contract: { ...TXT_INDEX_CONTRACT }, encoding, bomBytes, byteLength,
        textLength: textStart, lineCount, mode: headings ? "chapter-headings" : "fixed-500-lines" };
}

exports.scanTxtStream = scanTxtStream;
