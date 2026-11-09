import { useAnnotationPage } from "../../../utils/hooks/useAnnotationPage";
import { isElectron } from "react-device-detect";
import AnnotationWorkspace from "../../../components/annotations/workspace";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import "./noteList.css";
import CardList from "../cardList";
import NoteTag from "../../../components/noteTag";
import Empty from "../../emptyPage";
import { Trans } from "react-i18next";
import ConfigUtil from "../../../utils/file/configUtil";
import BookUtil from "../../../utils/file/bookUtil";
import Note from "../../../models/Note";
import { useAppStore } from "../../../store/useAppStore";

const LegacyNoteList = (props:{onManage?:()=>void}) => {
  const allBooks = useAppStore((s)=>s.manager.books);
  const nativeKeyword = useAppStore((s)=>s.manager.annotationSearchKeyword);
  const noteSortCode=useAppStore(s=>s.manager.noteSortCode);
  const notes = useAppStore((s) => s.reader.notes);
  const highlights = useAppStore((s) => s.reader.highlights);
  const isSearch = useAppStore((s) => s.manager.isSearch);
  const isCollapsed = useAppStore((s) => s.sidebar.isCollapsed);
  const searchResults = useAppStore((s) => s.manager.searchResults);
  const tabMode = useAppStore((s) => s.sidebar.mode);
  const handleFetchNotes = useAppStore((s) => s.handleFetchNotes);
  const { t } = useTranslation();
  const [tag, setTag] = useState<string[]>([]);
  const [bookNamesMap, setBookNamesMap] = useState<Record<string, string>>({});
  const [cardList, setCardList] = useState<Note[]>([]);
  const [bookFilter,setBookFilter]=useState("");
  const nativePage=useAnnotationPage(isElectron,{bookKey:bookFilter,kind:"small",tab:tabMode,tags:tag,keyword:isSearch?nativeKeyword:"",order:noteSortCode.order===1?"ASC":"DESC",sort:noteSortCode.sort===2?"position":"date"},tabMode==="note"?notes:highlights);
  useEffect(()=>{
    let active=true;
    if(isElectron)void BookUtil.getBookNamesMapByKeys([...new Set(nativePage.records.map(note=>note.bookKey))]).then(map=>{if(active)setBookNamesMap(map);});
    return()=>{active=false;};
  },[nativePage.records]);

  const handleNamesMap = async (notes: Note[]) => {
    let uniqueBookKeys = Array.from(new Set(notes.map((note) => note.bookKey)));
    let map = await BookUtil.getBookNamesMapByKeys(uniqueBookKeys);

    setBookNamesMap(map);
  };

  useEffect(() => {
    handleFetchNotes();
  }, []);

  useEffect(() => {
    if(isElectron)return;
    const currentNotes = tabMode === "note" ? notes : highlights;
    setCardList(currentNotes);
    handleNamesMap(currentNotes);
  }, [notes, highlights, tabMode]);

  const handleTag = async (newTag: string[]) => {
    if(isElectron){setTag(newTag);return;}
    if (newTag.length === 0) {
      setTag([]);
      setCardList(tabMode === "note" ? notes : highlights);
      return;
    }
    let nextCardList = await ConfigUtil.getNoteWithTags(newTag);
    nextCardList = nextCardList.filter((note) =>
      tabMode === "note"
        ? note.notes !== "" && (note.kind ? note.kind === "small" : note.notes !== "annotation")
        : note.notes === ""
    );
    setTag(newTag);
    setCardList(nextCardList);
  };

  const noteProps = {
    cards: isElectron ? nativePage.records : isSearch ? searchResults : cardList,
    mode: tabMode,
    summaries: isElectron,
    bookNamesMap: bookNamesMap,
  };
  return (
    <div
      className="note-list-container-parent"
      style={
        isCollapsed
          ? { width: "calc(100vw - 70px)", left: "70px" }
          : {}
      }
    >
      <div className="note-list-header">
        {props.onManage&&<button className="book-manage-title" onClick={props.onManage}>{t("Annotations")}</button>}
        <div className="note-tags" style={{ width: props.onManage ? "calc(100% - 340px)" : "calc(100% - 240px)" }}>
          <NoteTag {...({ handleTag: handleTag } as any)} />
        </div>
        {(isElectron || noteProps.cards.length > 0) && (
          <div style={{ marginRight: "10px", marginTop: "3px" }}>
            <span className="note-list-filter-label">
              <Trans>Filter by book</Trans>
            </span>

            <select
              aria-label={t("Filter by book")}
              value={isElectron ? bookFilter : undefined}
              className="lang-setting-dropdown"
              onChange={async (event) => {
                if(isElectron){setBookFilter(event.target.value);return;}
                setCardList(
                  await ConfigUtil.getNotesByBookKeyAndTypeWithSort(
                    event.target.value,
                    tabMode
                  )
                );
              }}
            >
              {[
                { value: "", label: t("Please select") },
                ...(isElectron?(allBooks||[]).map(book=>({bookKey:book.key})):tabMode === "note" ? notes : highlights)
                  .map((note) => {
                    return {
                      label: bookNamesMap[note.bookKey] || allBooks?.find(book=>book.key===note.bookKey)?.name || "Unknown book",
                      value: note.bookKey,
                    };
                  })
                  .filter(
                    (item, index, self) =>
                      self.findIndex((entry) => entry.value === item.value) === index
                  ),
              ].map((item) => (
                <option
                  value={item.value}
                  key={item.value}
                  className="lang-setting-option"
                >
                  {item.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {isElectron&&<div className="annotation-page-controls" data-annotation-pager="manager">
        <button disabled={nativePage.offset===0||nativePage.loading} onClick={nativePage.previous}>{t("Previous")}</button>
        <span>{Math.floor(nativePage.offset/100)+1}</span>
        <button disabled={!nativePage.hasMore||nativePage.loading} onClick={nativePage.next}>{t("Next")}</button>
        {nativePage.error&&<span role="alert">{t("Failed to load annotations")}</span>}
      </div>}
      {noteProps.cards.length === 0 ? (
        <div
          style={{
            position: "fixed",
            left: 0,
            top: 0,
            width: "100%",
            height: "100%",
            zIndex: -1,
          }}
        >
          {tag.length === 0 && <Empty />}
        </div>
      ) : (
        <CardList {...(noteProps as any)} />
      )}
    </div>
  );
};

// UI-4: Electron opens the single-book workspace directly. The old mixed
// notes/highlights screen remains only for the unchanged web route.
const NoteList=()=>isElectron?<AnnotationWorkspace/>:<LegacyNoteList/>;
export default NoteList;
