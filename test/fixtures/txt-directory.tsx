import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as Kookit from "/src/assets/lib/kookit.min.js";
import { openPersistentTxt } from "/src/utils/storage/txtIndexService.ts";
import { useAppStore } from "/src/store/useAppStore.ts";
import { ConfigService } from "/src/assets/lib/kookit-extra-browser.min.js";
import ContentList from "/src/containers/lists/contentList/component.tsx";
import { scrollContents } from "/src/utils/common.ts";
import i18n from "/src/i18n.tsx";
export async function run() {
  await i18n.changeLanguage("en");
  const assert = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (check: () => boolean, message: string) => { const until = Date.now() + 10000; while (Date.now() < until) { if (check()) return; await pause(20); } throw Error(message); };
  const commands = () => window.electronAPI.invoke("directory-test-commands");
  const bodyCommands = async () => (await commands()).filter((c: { action: string }) => ["read-chapter", "read-source"].includes(c.action));
  const opened = await openPersistentTxt("directory", "", "utf-8", "^Chapter ");
  const rendition = Kookit.BookHelper.getRendition(opened.buffer, { format: "TXT", charset: opened.encoding, parserRegex: "^Chapter ", txtIndexStore: opened.store, readerMode: "scroll", animation: "none", isMobile: "no", platform: "electron" }, Kookit);
  await rendition.renderTo(document.getElementById("page-area"));
  await rendition.goToChapterDocIndex(0);
  const tree = rendition.getChapter(), flat = rendition.flatChapter(tree);
  useAppStore.setState(s => ({ book: { ...s.book, currentBook: { ...s.book.currentBook, key: "directory", format: "TXT" } }, reader: { ...s.reader, htmlBook: { key: "directory", chapters: tree, flattenChapters: flat, rendition }, currentChapterIndex: 0, currentChapter: tree[0].label } }));
  const host = document.getElementById("contents")!, root = createRoot(host);
  const render = (active: boolean) => flushSync(() => root.render(<React.StrictMode><ContentList isActive={active} /></React.StrictMode>));
  const before = (await bodyCommands()).length;
  render(true);
  await wait(() => !!host.querySelector('[data-chapter-index="0"]'), "Initial directory row missing");
  let cases = 0, maximumRows = 0;
  const viewport = () => host.querySelector<HTMLElement>(".txt-content-viewport")!;
  const countRows = () => { const n = host.querySelectorAll(".txt-content-row").length; maximumRows = Math.max(n, maximumRows); assert(n > 0 && n <= 120, "Unbounded or empty virtual rows"); };
  const scroll = async (index: number) => {
    viewport().scrollTop = Math.min(viewport().scrollHeight - viewport().clientHeight, index * 40);
    viewport().dispatchEvent(new Event("scroll"));
    await wait(() => !!host.querySelector(`[data-chapter-index="${index}"]`), `Unrendered virtual index ${index}`);
    countRows();
  };
  const marker = () => host.querySelector<HTMLElement>('[aria-current="location"]')?.closest("li")?.getAttribute("data-chapter-index");
  countRows();
  for (const index of [499, 6799, 7699, 0, 5000, 6799]) await scroll(index);
  assert((await bodyCommands()).length === before, "Directory scrolling read a body"); cases++;
  for (let index = 0; index < 7700; index += 300) {
    viewport().scrollTop = index * 40; viewport().dispatchEvent(new Event("scroll"));
  }
  await pause(); countRows();
  assert((await bodyCommands()).length === before, "Fast scroll read a body"); cases++;
  const targets = [0, 499, 6799];
  const jumpStart = (await bodyCommands()).length;
  for (const index of targets) {
    await scroll(index);
    const top = viewport().scrollTop;
    (host.querySelector(`[data-chapter-index="${index}"] button`) as HTMLButtonElement).click();
    await wait(() => marker() === String(index), "Chapter marker did not update immediately");
    await wait(() => rendition.getDocument().body.textContent.includes(`SYNTHETIC_BODY_${index + 1}😀`), "Chapter ID jumped to wrong body");
    assert(viewport().scrollTop === top, "Chapter click moved the directory");
  }
  const jumped = (await bodyCommands()).slice(jumpStart).map((c: { chapterIndex: number }) => c.chapterIndex);
  // The initial chapter may already be in phase-9's bounded direct-text LRU.
  // A hit needs no range read; uncached destinations must still load directly.
  assert(jumped.length <= targets.length && jumped.every(index=>targets.includes(index)) &&
    targets.slice(1).every(index=>jumped.includes(index)), "Deep jumps read intermediate chapter bodies: "+JSON.stringify(jumped)); cases++;
  const title = host.querySelector<HTMLElement>('[data-chapter-index="6799"] button')!;
  assert(title.clientHeight === 40 && title.title.length > 200, "Long Chinese title changed virtual row height"); cases++;
  await window.electronAPI.invoke("directory-test-preview");
  await scroll(2000); const manualTop = viewport().scrollTop;
  flushSync(() => useAppStore.getState().handleCurrentChapterIndex(500));
  scrollContents("Chapter 501", "title500");
  await pause();
  assert(viewport().scrollTop === manualTop, "Reading position interrupted manual directory scrolling");
  // A page-count refresh may update metadata, but must not realign a browsing user.
  rendition.trigger("chapter-pages"); await pause(100);
  assert(viewport().scrollTop === manualTop, "Page refresh interrupted manual browsing"); cases++;
  render(false); render(true);
  await wait(() => marker() === "500", "Reopening did not mount the current row");
  assert(Math.abs(viewport().scrollTop - (500 * 40 + 20 - viewport().clientHeight / 2)) < 2, "Reopening did not center current row"); cases++;
  const readBeforeSearch = (await bodyCommands()).length;
  (host.querySelector(".book-content-expand") as HTMLButtonElement).click();
  await wait(() => !!host.querySelector("input"), "Search input missing");
  const input = host.querySelector<HTMLInputElement>("input")!;
  const set = (value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); };
  set("Chapter"); await pause(); await scroll(6799); countRows();
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  set("不存在"); await pause();
  assert(host.querySelectorAll(".txt-content-row").length > 0, "IME draft filtered the directory before commit");
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "不存在" }));
  await wait(() => host.textContent!.includes("No results found"), "IME search did not commit");
  assert(ConfigService.getReaderConfig("isTempLocked") !== "yes", "IME left reader navigation locked"); cases++;
  set("Chapter 6800");
  await wait(() => host.querySelectorAll(".txt-content-row").length === 1, "Unique chapter search mismatch");
  assert(!!host.querySelector('[data-chapter-index="6799"]'), "Search lost source chapter index");
  set("Chapter"); await pause(); await scroll(7699); countRows();
  assert((await bodyCommands()).length === readBeforeSearch, "Searching/reopening directory read bodies"); cases++;
  const inputResponses: number[] = [];
  for (let i = 0; i < 20; i++) {
    const query = i % 2 ? "Chapter 6800" : "Chapter 7700";
    const expected = i % 2 ? "6799" : "7699";
    const started = performance.now();
    set(query);
    await wait(() => host.querySelectorAll(".txt-content-row").length === 1 && !!host.querySelector(`[data-chapter-index="${expected}"]`), "Input did not settle");
    inputResponses.push(performance.now() - started);
  }
  inputResponses.sort((a, b) => a - b);
  assert((await bodyCommands()).length === readBeforeSearch, "Input benchmark read a body"); cases++;
  // Pinned generation remains readable after another session invalidates it.
  const original = await rendition.getTxtDirectory();
  const other = await openPersistentTxt("directory", "", "utf-8", "^Chapter ");
  await other.store!.invalidate(); await other.store!.close();
  assert((await rendition.getTxtDirectory()).generation === original.generation, "Directory followed an invalidated active pointer"); cases++;
  // Inactive search releases an owned IME lock without touching a preexisting lock.
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); render(false);
  assert(ConfigService.getReaderConfig("isTempLocked") !== "yes", "Hiding directory retained IME lock");
  ConfigService.setReaderConfig("isNavLocked", "yes"); render(true);
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  assert(ConfigService.getReaderConfig("isNavLocked") === "yes", "IME cleared existing navigation lock");
  ConfigService.setReaderConfig("isNavLocked", ""); cases++;
  root.unmount();
  // Other formats and the explicit TXT fallback retain the existing tree route.
  const fallbackRoot = createRoot(host);
  ConfigService.setReaderConfig("isDisableTxtVirtualContents", "yes");
  flushSync(() => fallbackRoot.render(<ContentList isActive={false} />));
  assert(!host.querySelector("[data-txt-virtual-contents]") && !!host.querySelector(".book-content"), "TXT fallback flag did not preserve tree route");
  ConfigService.setReaderConfig("isDisableTxtVirtualContents", "");
  useAppStore.setState(s => ({ book: { ...s.book, currentBook: { ...s.book.currentBook, format: "EPUB" } } }));
  flushSync(() => fallbackRoot.render(<ContentList isActive={false} />));
  assert(!host.querySelector("[data-txt-virtual-contents]"), "Non-TXT tree route replaced"); cases++;
  fallbackRoot.unmount(); rendition.removeContent(); await opened.store!.close();
  return { passed: true, cases, chapterCount: 7700, maximumRows, deepJumpBodyIndices: jumped, strictMode: true, directorySourceReads: 0, searchInputSamples: inputResponses.length, searchInputP95Ms: Math.round(inputResponses[18] * 10) / 10, inputPollingResolutionMs: 20 };
}
