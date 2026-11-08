import type Book from "../../models/Book";
import { getParserRegex } from "../common";
import { openPersistentTxt, TxtBuildProgress } from "./txtIndexService";
import DatabaseService from "./databaseService";
import { useAppStore } from "../../store/useAppStore";
export interface RecoveryOptions { signal: AbortSignal; onProgress: (progress: TxtBuildProgress | null) => void; }
export async function rebuildTxt(book: Book, options: RecoveryOptions & {requireSelectedSource?:boolean}) {
  const source = await openPersistentTxt(book.key, book.path, book.charset, getParserRegex("TXT", book.key), options);
  try {
    if (!source.store) throw Error("Unsupported TXT source encoding");
    return await source.store.prepare("rebuild");
  } finally { await source.store?.close(); }
}
export async function relocateTxt(book: Book, options: RecoveryOptions): Promise<Book | undefined> {
  const selected = await window.electronAPI.invoke("select-file", { filters: [{ name: "TXT", extensions: ["txt"] }] });
  if (!selected || options.signal.aborted) return;
  if (typeof selected !== "string") throw Error("Invalid TXT source selection");
  const replacement = { ...book, path: selected };
  // Validate/scan/reconcile the actual selected source before persisting its path.
  // No source copy is made and book key, bookmarks and progress stay attached.
  await rebuildTxt(replacement, {...options,requireSelectedSource:true});
  if (options.signal.aborted) return;
  await DatabaseService.updateRecord(replacement, "books");
  const state = useAppStore.getState();
  if (state.book.currentBook.key === book.key) state.handleReadingBook(replacement);
  await state.handleFetchBooks();
  return replacement;
}
