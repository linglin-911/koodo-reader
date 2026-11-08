import { AnnotationService, BindingInput } from "../storage/annotationService";
import { getIframeDoc } from "./docUtil";
import type Book from "../../models/Book";
import { useAppStore } from "../../store/useAppStore";
interface Rendition {
  getAnnotationAnchor?: () => BindingInput;
  getTxtChapterSnapshot?: () => { chapterId: string };
  txtIndexStore?: { sourceTicket?: string };
  getHighlightCoords: (index: number) => Promise<unknown>;
  getPosition: () => unknown;
  getPositionByChapter?: (index: number) => unknown;
  renderHighlighters: (
    rows: unknown[],
    click: (event: Event) => void,
    chapterIndex?: number
  ) => Promise<void>;
}
export const annotationTarget = (event: Event) => {
  const element = (event.target as Element)?.closest<HTMLElement>("[data-key]");
  useAppStore
    .getState()
    .handleAnnotationTarget(
      element?.dataset.noteKey || element?.dataset.key || "",
      element?.dataset.bindingId || ""
    );
  useAppStore.getState().handleMenuMode("note");
  useAppStore.getState().handleOpenMenu(true);
};
export const captureAnnotation = async (
  book: Book,
  rendition: Rendition,
  index: number,
  chapter: string,
  style: string
): Promise<BindingInput> => {
  if (book.format === "TXT") {
    if (!rendition.getAnnotationAnchor)
      throw new Error("Source mapping is unavailable");
    return { ...rendition.getAnnotationAnchor(), style };
  }
  const quote =
    getIframeDoc(book)
      .map((doc) => doc?.getSelection()?.toString() || "")
      .find(Boolean) || "";
  if (!quote) throw new Error("Select source text first");
  return {
    format: book.format,
    chapterIndex: index,
    chapter,
    style,
    quote,
    range: JSON.stringify(await rendition.getHighlightCoords(index)),
    cfi: JSON.stringify(
      book.format === "PDF" && rendition.getPositionByChapter
        ? rendition.getPositionByChapter(index)
        : rendition.getPosition()
    ),
    percentage: "0",
  };
};
const restoreVersions = new WeakMap<Rendition, number>();
export const restoreAnnotations = async (
  book: Book,
  rendition: Rendition,
  index: number
) => {
  const version = (restoreVersions.get(rendition) || 0) + 1;
  restoreVersions.set(rendition, version);
  const chapter = rendition.getTxtChapterSnapshot?.();
  const rows = await AnnotationService.reading({
    bookKey: book.key,
    format: book.format,
    chapterIndex: index,
    sourceTicket: rendition.txtIndexStore?.sourceTicket,
    chapterId: chapter?.chapterId,
  });
  if (book.format !== "TXT") {
    const drawings = (
      await AnnotationService.list({ bookKey: book.key, tab: "annotation" })
    ).records;
    rows.push(
      ...drawings
        .filter((note) => note.chapterIndex === index)
        .map((note) => ({
          ...note,
          entityKey: note.key,
          bindingId: note.key,
          hasNote: false,
        }))
    );
  }
  if (restoreVersions.get(rendition) !== version ||
      (chapter && rendition.getTxtChapterSnapshot?.()?.chapterId !== chapter.chapterId)) return;
  await rendition.renderHighlighters(rows, annotationTarget, index);
  for (const doc of getIframeDoc(book)) {
    if (!doc) continue;
    for (const element of Array.from(
      doc.querySelectorAll<HTMLElement>("[data-key]")
    )) {
      const row = rows.find((item) => item.key === element.dataset.key);
      if (row) {
        element.dataset.noteKey = row.entityKey;
        element.dataset.bindingId = row.bindingId;
      }
    }
  }
};
export const notifyAnnotations = () => {
  void useAppStore.getState().handleFetchNotes();
  const rendition = useAppStore.getState().reader.htmlBook?.rendition;
  rendition?.trigger?.("rendered");
};

export const canJumpAnnotation = (
  location: Record<string, unknown>,
  rendition: {
    book?: { sections?: Array<{ chapter?: { chapterId: string } }> };
  }
) => {
  if (location.annotationUnbound) return false;
  if (!location.annotationBindingId) return true;
  if (location.annotationStatus !== "active") return false;
  return (
    location.annotationFormat !== "TXT" ||
    rendition.book?.sections?.[Number(location.chapterDocIndex)]?.chapter
      ?.chapterId === location.annotationChapterId
  );
};
