import { useTranslation } from "react-i18next";
import PopupNote from "../popupNote";
import { getIframeDoc } from "../../../utils/reader/docUtil";
import { useAppStore } from "../../../store/useAppStore";
import "./popupMenu.css";

export interface PopupBoxProps {
  rendition: unknown;
  rect: DOMRect | null;
  chapterDocIndex: number;
  chapter: string;
}

export default function PopupBox(props: PopupBoxProps) {
  const { t } = useTranslation();
  const currentBook = useAppStore((s) => s.book.currentBook);
  const menuMode = useAppStore((s) => s.viewArea.menuMode);
  const isOpenMenu = useAppStore((s) => s.viewArea.isOpenMenu);
  const close = () => {
    const store = useAppStore.getState();
    store.handleOpenMenu(false);
    store.handleShowPopupNote(false);
    store.handleMenuMode("");
    store.handleAnnotationTarget("");
    for (const doc of getIframeDoc(currentBook)) doc?.getSelection()?.removeAllRanges();
  };
  if (!isOpenMenu || menuMode !== "note") return null;
  return (
    <>
      <div className="popup-box-container small-annotation-popup" role="dialog"
        aria-modal="true" aria-label={t("Small annotation")}>
        <div className="popup-box-inner">
          <PopupNote isDockedRight={false} chapterDocIndex={props.chapterDocIndex} chapter={props.chapter} />
          <button type="button" className="small-annotation-close" aria-label={t("Close")}
            title={t("Close")} onClick={close}>
            <span className="icon-close" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="drag-background small-annotation-backdrop" onClick={close} />
    </>
  );
}
