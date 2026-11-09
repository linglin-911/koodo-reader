import { isElectron } from "react-device-detect";
import { AnnotationService } from "../storage/annotationService";
import { captureAnnotation, restoreAnnotations } from "./annotationUtil";
import Note from "../../models/Note";
import { isReadingRawPDF } from "../common";
import DatabaseService from "../storage/databaseService";
import {
  ConfigService,
  NoteSyncManager,
} from "../../assets/lib/kookit-extra-browser.min";
import { getIframeDoc } from "./docUtil";

export interface DigestParams {
  currentBook: any;
  htmlBook: any;
  chapterDocIndex: number;
  chapter: string;
  color: string;
  t: (key: string) => string;
  onNoteClick?: (event: Event) => void;
  onSuccess?: () => void;
}

export async function createHighlight(params: DigestParams): Promise<void> {
  const {
    currentBook,
    htmlBook,
    chapterDocIndex,
    chapter,
    color,
    onNoteClick,
    onSuccess,
  } = params;

  if (!htmlBook) return;
  if (isElectron) {
    const {openQuickAnnotation}=await import("../../components/annotations/readerEvents");
    openQuickAnnotation({kind:"small",selection:true});return;
    /* UI-2: legacy pure-highlight creation is replaced by the body editor.
    const binding=await captureAnnotation(currentBook,htmlBook.rendition,chapterDocIndex,chapter,color);
    await AnnotationService.create({bookKey:currentBook.key,kind:"small",notes:"",tag:[]},binding);
    await restoreAnnotations(currentBook,htmlBook.rendition,chapterDocIndex);
    onSuccess?.();return; */
  }

  let bookKey = currentBook.key;
  let bookLocation = ConfigService.getObjectConfig(
    bookKey,
    "recordLocation",
    {}
  );
  let cfi = JSON.stringify(bookLocation);

  if (isReadingRawPDF(currentBook)) {
    let pdfLocation = htmlBook.rendition.getPositionByChapter(chapterDocIndex);
    cfi = JSON.stringify(pdfLocation);
  }

  let percentage = bookLocation.percentage ? bookLocation.percentage : "0";
  let docs = getIframeDoc(currentBook);
  let text = "";
  for (let i = 0; i < docs.length; i++) {
    let doc = docs[i];
    if (!doc) continue;
    text = doc.getSelection()?.toString() || "";
    if (text) break;
  }
  if (!text) return;

  text = text.replace(/\s\s/g, "");
  text = text.replace(/\r/g, "");
  text = text.replace(/\n/g, "");
  text = text.replace(/\t/g, "");
  text = text.replace(/\f/g, "");

  let range = JSON.stringify(
    await htmlBook.rendition.getHighlightCoords(chapterDocIndex)
  );

  let highlight = new Note(
    bookKey,
    chapter,
    chapterDocIndex,
    text,
    cfi,
    range,
    "",
    percentage,
    color,
    []
  );

  await DatabaseService.saveRecord(highlight, "notes");
  await htmlBook.rendition.createOneNote(highlight, onNoteClick ?? (() => {}));
  let noteSyncManager = new NoteSyncManager(
    DatabaseService,
    ConfigService,
    window.electronAPI?.fs,
    window.electronAPI?.path
  );
  noteSyncManager.syncNote(highlight, bookKey);
  onSuccess?.();
}
