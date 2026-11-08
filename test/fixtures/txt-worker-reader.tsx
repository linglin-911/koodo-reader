import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as Kookit from "/src/assets/lib/kookit.min.js";
import { openPersistentTxt, clearPersistentTxtCache, queueImportedTxtIndex } from "/src/utils/storage/txtIndexService.ts";
import type { TxtBuildProgress } from "/src/utils/storage/txtIndexService.ts";
import TxtIndexProgress from "/src/containers/viewer/txtIndexProgress.tsx";
import i18n from "/src/i18n.tsx";
export async function run() {
  await i18n.changeLanguage("en");
  const assert = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const wait = async (check: () => boolean) => { const until = Date.now() + 10000; while (Date.now() < until) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw Error("Worker UI condition timed out"); };
  const host = document.getElementById("contents")!, root = createRoot(host);
  let controller = new AbortController(), renders = 0, previewBeforeReady = false;
  const show = (progress: TxtBuildProgress | null) => {
    if (progress) flushSync(() => root.render(<React.StrictMode><TxtIndexProgress progress={progress}
      cancel={() => { controller.abort(); show({ state: "cancelled" }); }} retry={() => {}} /></React.StrictMode>));
    renders++;
  };
  const open = () => openPersistentTxt("directory", "", "utf-8", "^Chapter ", { signal: controller.signal, onProgress: show });
  let source = await open();
  const first = source.store!.prepare().then(() => false, () => true);
  await wait(() => !!host.querySelector("pre"));
  assert(host.querySelector("pre")!.textContent!.includes("SYNTHETIC_BODY_1😀"), "Temporary source preview missing");
  assert(await source.store!.load(false) === null, "Partial index exposed as ready");
  const range = document.createRange(); range.selectNodeContents(host.querySelector("pre")!);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
  assert(document.getSelection()!.toString().includes("SYNTHETIC_BODY_1😀"), "Temporary preview is not selectable");
  previewBeforeReady = true;
  await window.electronAPI.invoke("directory-test-preview");
  (host.querySelector("button") as HTMLButtonElement).click();
  assert(await first, "Cancel failed to abort prepare");
  assert(host.textContent!.includes("Cancelled"), "Cancelled status missing");
  controller = new AbortController(); source = await open();
  let ticks = 0; const heartbeat = setInterval(() => ticks++, 10);
  await source.store!.prepare(); clearInterval(heartbeat);
  assert(ticks > 5 && renders > 2, "Renderer did not remain interactive during scan");
  const rendition = Kookit.BookHelper.getRendition(source.buffer, { format: "TXT", charset: source.encoding, parserRegex: "^Chapter ", txtIndexStore: source.store,
    readerMode: "scroll", animation: "none", isMobile: "no", platform: "electron" }, Kookit);
  await rendition.renderTo(document.getElementById("page-area")); await rendition.goToChapterDocIndex(6799);
  assert(rendition.getDocument().body.textContent.includes("SYNTHETIC_BODY_6800😀"), "Post-ready deep restore failed");
  const directory = await rendition.getTxtDirectory(); assert(directory.chapters.length === 7700, "Full directory unavailable after ready");
  const commands = await window.electronAPI.invoke("directory-test-commands");
  assert(!commands.some((c: { action: string }) => c.action === "read-source"), "Worker used a whole-book Renderer transfer");
  const before = (await window.electronAPI.invoke("worker-test-stats")).workers;
  const hot = await openPersistentTxt("directory", "", "utf-8", "^Chapter ");
  assert(hot.cacheHit, "Post-ready hot open missed index"); await hot.store!.close();
  assert((await window.electronAPI.invoke("worker-test-stats")).workers === before, "Hot open started a Worker");
  rendition.removeContent(); await source.store!.close();
  await clearPersistentTxtCache("directory", "", "utf-8", "^Chapter ");
  const imports = new AbortController();
  await queueImportedTxtIndex({ key: "directory", path: "", charset: "utf-8" }, "^Chapter ", imports.signal);
  const imported = await openPersistentTxt("directory", "", "utf-8", "^Chapter ");
  assert(imported.cacheHit, "Import background task did not produce a hot index"); await imported.store!.close();
  imports.abort(); let cancelled = false;
  try { await queueImportedTxtIndex({ key: "directory", path: "", charset: "utf-8" }, "^Chapter ", imports.signal); }
  catch { cancelled = true; }
  assert(cancelled, "Closed import consumer continued scanning");
  root.unmount();
  return { passed: true, cases: 8, previewBeforeReady, rendererHeartbeatTicks: ticks, wholeSourceTransfers: 0, hotWorkerStarts: 0, importedIndexHit: true };
}
