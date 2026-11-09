import NativeTextPopup from "./nativeTextPopup";
import { isElectron } from "react-device-detect";
import AnnotationEditor from "../../annotations/editor";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import "./popupNote.css";
import { isReadingRawPDF } from "../../../utils/common";
import Note from "../../../models/Note";
import NoteTag from "../../noteTag";
import { getIframeDoc } from "../../../utils/reader/docUtil";
import {
  ConfigService,
  HighlightUtil,
  NoteSyncManager,
} from "../../../assets/lib/kookit-extra-browser.min";
import DatabaseService from "../../../utils/storage/databaseService";
import { useAppStore } from "../../../store/useAppStore";

export interface PopupNoteProps {
  isDockedRight: boolean;

  chapterDocIndex: number;
  chapter: string;
}

const highlightUtil: any = new HighlightUtil(ConfigService);

const LegacyPopupNote = (props: PopupNoteProps) => {
  const currentBook = useAppStore((s) => s.book.currentBook);
  const highlight = useAppStore((s) => s.reader.highlight);
  const htmlBook = useAppStore((s) => s.reader.htmlBook);
  const noteKey = useAppStore((s) => s.reader.noteKey);
  const handleNoteKey = useAppStore((s) => s.handleNoteKey);
  const handleOpenMenu = useAppStore((s) => s.handleOpenMenu);
  const handleShowPopupNote = useAppStore((s) => s.handleShowPopupNote);
  const handleMenuMode = useAppStore((s) => s.handleMenuMode);
  const handleFetchNotes = useAppStore((s) => s.handleFetchNotes);
  const { t } = useTranslation();
  const [tag, setTag] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    let textArea: any = document.querySelector(".editor-box");
    textArea && textArea.focus();
    (async () => {
      if (noteKey) {
        let loadedNote: Note = await DatabaseService.getRecord(
          noteKey,
          "notes"
        );
        setText(loadedNote.text);
        setTag(loadedNote.tag);
        setNote(loadedNote);
        if (textArea) {
          textArea.value = loadedNote.notes;
        }
      } else {
        let docs = getIframeDoc(currentBook);
        let selectedText = "";
        for (let i = 0; i < docs.length; i++) {
          let doc = docs[i];
          if (!doc) continue;
          selectedText = doc.getSelection()?.toString() || "";
          if (selectedText) {
            break;
          }
        }
        if (!selectedText) return;

        selectedText = selectedText.replace(/\s\s/g, "");
        selectedText = selectedText.replace(/\r/g, "");
        selectedText = selectedText.replace(/\n/g, "");
        selectedText = selectedText.replace(/\t/g, "");
        selectedText = selectedText.replace(/\f/g, "");
        setText(selectedText);
      }
    })();
  }, []);

  const handleTag = (nextTag: string[]) => {
    setTag(nextTag);
  };

  const handleNoteClick = (event: Event) => {
    handleNoteKey((event.target as any).dataset.key);
    handleMenuMode("note");
    handleOpenMenu(true);
  };

  const createNote = async () => {
    let notes = (document.querySelector(".editor-box") as HTMLInputElement)
      .value;

    if (!notes.trim()) return;
    if (noteKey) {
      let newNote = await DatabaseService.getRecord(noteKey, "notes");
      newNote.notes = notes;
      newNote.tag = tag;
      DatabaseService.updateRecord(newNote, "notes").then(() => {
        handleOpenMenu(false);
        handleFetchNotes();
        handleMenuMode("");
        handleNoteKey("");
        handleShowPopupNote(false);
        if (htmlBook && htmlBook.rendition) {
          htmlBook.rendition.removeOneNote(
            noteKey,
            props.chapterDocIndex
          );
          htmlBook.rendition.createOneNote(newNote, handleNoteClick);
        }
      });
    } else {
      let cfi = JSON.stringify(
        ConfigService.getObjectConfig(
          currentBook.key,
          "recordLocation",
          {}
        )
      );
      if (isReadingRawPDF(currentBook)) {
        let bookLocation = htmlBook.rendition.getPositionByChapter(
          props.chapterDocIndex
        );
        cfi = JSON.stringify(bookLocation);
      }
      let bookKey = currentBook.key;
      let range = JSON.stringify(
        await htmlBook.rendition.getHighlightCoords(
          props.chapterDocIndex
        )
      );

      let percentage = ConfigService.getObjectConfig(
        currentBook.key,
        "recordLocation",
        {}
      ).percentage
        ? ConfigService.getObjectConfig(
            currentBook.key,
            "recordLocation",
            {}
          ).percentage
        : "0";

      let color =
        highlightUtil.formatHighlightValue(highlight) ||
        "background-#FEF3CD";

      let newNote = new Note(
        bookKey,
        props.chapter,
        props.chapterDocIndex,
        text,
        cfi,
        range,
        notes,
        percentage,
        color,
        tag
      );
      DatabaseService.saveRecord(newNote, "notes").then(async () => {
        handleOpenMenu(false);
        handleFetchNotes();
        handleMenuMode("");
        await htmlBook.rendition.createOneNote(
          newNote,
          handleNoteClick
        );
        let noteSyncManager = new NoteSyncManager(
          DatabaseService,
          ConfigService,
          window.electronAPI?.fs,
          window.electronAPI?.path
        );
        noteSyncManager.syncNote(newNote, bookKey);
      });
    }
  };

  return (
    <div className="note-editor">
      <div className="note-original-text">{text}</div>
      <div className="editor-box-parent">
        <textarea
          className="editor-box"
          aria-label={t("Annotation body")}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey) &&
              !(event.nativeEvent as any).isComposing
            ) {
              event.preventDefault();
              createNote();
            }
          }}
        />
      </div>
      <div className="note-tags">
        <NoteTag
          {...({
            handleTag: handleTag,
            tag: noteKey && note ? note.tag : [],
          } as any)}
        />
      </div>

      <div className="note-button-container">
        <button type="button" className="small-annotation-confirm" onClick={() => void createNote()}>
          {t("Confirm")}
        </button>
      </div>
    </div>
  );
};

const NativePopupNote = (props: PopupNoteProps) => {
  const noteKey=useAppStore(s=>s.reader.noteKey),bindingId=useAppStore(s=>s.reader.noteBindingId),append=useAppStore(s=>s.reader.annotationAppend);
  const currentBook=useAppStore(s=>s.book.currentBook),htmlBook=useAppStore(s=>s.reader.htmlBook);
  const [kind,setKind]=useState("small"),[loadedKey,setLoadedKey]=useState<string|null>(null);
  useEffect(()=>{let active=true;if(noteKey)void DatabaseService.getRecord(noteKey,"notes").then(note=>{if(active){setKind(note?.kind||"small");setLoadedKey(noteKey);}}).catch(()=>{if(active){setKind("small");setLoadedKey(noteKey);}});return()=>{active=false;};},[noteKey]);
  const close=()=>{const store=useAppStore.getState();store.handleOpenMenu(false);store.handleShowPopupNote(false);store.handleMenuMode("");store.handleNoteKey("");};
  if(noteKey&&loadedKey!==noteKey)return null;
  if(noteKey&&kind==="drawing")return <LegacyPopupNote {...props}/>;
  if(append||(noteKey&&kind!=="small"))return <AnnotationEditor key={noteKey||"append"} noteKey={noteKey||undefined} bindingId={bindingId} append={append} bookKey={currentBook?.key}
    selection={!noteKey&&!!htmlBook?.rendition} chapterIndex={props.chapterDocIndex} chapter={props.chapter} onClose={close}/>;
  return <NativeTextPopup key={`${noteKey}:${bindingId}`} {...props} noteKey={noteKey} bindingId={bindingId} onClose={close}/>;
};
const PopupNote=(props:PopupNoteProps)=>isElectron?<NativePopupNote {...props}/>:<LegacyPopupNote {...props}/>;
export default PopupNote;
