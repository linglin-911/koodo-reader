import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import copy from "copy-text-to-clipboard";
import { getSelection } from "../../../utils/reader/mouseEvent";
import { getIframeDoc } from "../../../utils/reader/docUtil";
import { isFixedLayoutBook, isReadingRawPDF } from "../../../utils/common";
import { useAppStore } from "../../../store/useAppStore";
import "./popupOption.css";

export interface PopupOptionProps {
  noteKey: string;
  rect: DOMRect;
  cfiRange: string;
  chapterDocIndex: number;
  chapter: string;
}

export default function PopupOption(_props: PopupOptionProps) {
  const { t } = useTranslation();
  const currentBook = useAppStore((s) => s.book.currentBook);
  const handleCopy = () => {
    let text = getSelection(currentBook);
    if (!text) return;
    if (isReadingRawPDF(currentBook)) text = text.split("\n").join(" ").trim();
    const docs = getIframeDoc(currentBook);
    let copied = false;
    for (const doc of docs) {
      if (copied) break;
      if (!doc?.getSelection()?.toString().trim()) continue;
      copied = doc.execCommand("copy");
    }
    if (!copied) copy(text);
    const store = useAppStore.getState();
    store.handleOpenMenu(false);
    store.handleMenuMode("");
    for (const doc of docs) doc?.getSelection()?.removeAllRanges();
    toast.success(t("Copying successful"));
  };
  return (
    <div className="menu-list">
      {!isFixedLayoutBook(currentBook) && (
        <button type="button" className="note-option"
          aria-label={t("Small annotation")} title={t("Small annotation")}
          data-tooltip-content={t("Small annotation")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const store = useAppStore.getState();
            store.handleAnnotationTarget("");
            store.handleMenuMode("note");
            store.handleOpenMenu(true);
          }}>
          <span className="icon-note note-icon" aria-hidden="true" />
        </button>
      )}
      <button type="button" className="copy-option"
        aria-label={t("Copy")} title={t("Copy")}
        data-tooltip-content={t("Copy")}
        onMouseDown={(event) => event.preventDefault()} onClick={handleCopy}>
        <span className="icon-copy copy-icon" aria-hidden="true" />
      </button>
    </div>
  );
}
