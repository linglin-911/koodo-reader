import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import { useAppStore } from "../../../store/useAppStore";
import { throttle } from "../../../utils/common";
import type { TxtDirectory } from "../../../utils/storage/txtIndexService";
import { TXT_ROW_HEIGHT, txtScrollToIndex, txtVirtualRange } from "./txtVirtual";
import "./contentList.css";

export default function TxtContentList({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation();
  const currentBook = useAppStore((s) => s.book.currentBook);
  const htmlBook = useAppStore((s) => s.reader.htmlBook);
  const currentIndex = useAppStore((s) => s.reader.currentChapterIndex);
  const handleCurrentChapter = useAppStore((s) => s.handleCurrentChapter);
  const handleCurrentChapterIndex = useAppStore((s) => s.handleCurrentChapterIndex);
  const handleJumpPosition = useAppStore((s) => s.handleJumpPosition);
  const [directory, setDirectory] = useState<TxtDirectory | null>(null);
  const [pages, setPages] = useState<number[]>([]);
  const [failed, setFailed] = useState(false);
  const [jumpFailed, setJumpFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [keyword, setKeyword] = useState("");
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const ownsImeLock = useRef(false);
  const aligned = useRef(false);
  const jumping = useRef(false);
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;

  const releaseIme = () => {
    composing.current = false;
    if (ownsImeLock.current) {
      ConfigService.setReaderConfig("isNavLocked", "");
      ConfigService.setReaderConfig("isTempLocked", "");
      ownsImeLock.current = false;
    }
  };
  useEffect(() => () => releaseIme(), []);
  useEffect(() => {
    if (!isActive) releaseIme();
  }, [isActive]);

  useEffect(() => {
    let alive = true;
    let request = 0;
    const rendition = htmlBook?.rendition;
    aligned.current = false;
    setDirectory(null);
    setFailed(false);
    const load = async () => {
      const token = ++request;
      try {
        const result: TxtDirectory = await rendition.getTxtDirectory();
        if (alive && token === request) {
          setDirectory(result);
          setPages(rendition.getPages());
          setFailed(false);
        }
      } catch {
        if (alive && token === request) setFailed(true);
      }
    };
    if (rendition) {
      void load();
      rendition.on("chapter-pages", load);
    }
    return () => {
      alive = false;
      rendition?.off("chapter-pages", load);
    };
  }, [htmlBook, retry]);

  // Read the latest element measurements in the trailing call, rather than
  // retaining the first event's position while the user is still scrolling.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let alive = true;
    const measure = throttle(() => {
      if (!alive) return;
      const top = element.scrollTop, height = element.clientHeight;
      setViewport((prev) => prev.top === top && prev.height === height ? prev : { top, height });
    }, 16);
    element.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      alive = false;
      element.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  const rows = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase();
    const chapters = directory?.chapters || [];
    return query ? chapters.filter((row) => row.label.toLocaleLowerCase().includes(query)) : chapters;
  }, [directory, keyword]);
  const range = txtVirtualRange(rows.length, viewport.top, viewport.height);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!isActive) { aligned.current = false; return; }
    if (aligned.current || !directory || !element?.clientHeight) return;
    aligned.current = true;
    const index = rows.findIndex((row) => row.index === currentIndexRef.current);
    if (index < 0) return;
    element.scrollTop = txtScrollToIndex(index, rows.length, element.clientHeight);
    setViewport({ top: element.scrollTop, height: element.clientHeight });
    // Reading-position updates intentionally do not retrigger open alignment.
  }, [isActive, directory, rows, viewport.height]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) {
      element.scrollTop = 0;
      setViewport({ top: 0, height: element.clientHeight });
    }
  }, [keyword]);
  useEffect(() => { if (searchOpen && isActive) input.current?.focus(); }, [searchOpen, isActive]);

  const jump = async (row: TxtDirectory["chapters"][number]) => {
    if (jumping.current) return;
    jumping.current = true;
    const previous = useAppStore.getState().reader;
    handleJumpPosition(ConfigService.getObjectConfig(currentBook.key, "recordLocation", {}));
    // Update the marker immediately; keep the user's directory scroll position.
    handleCurrentChapter(row.label);
    handleCurrentChapterIndex(row.index);
    setJumpFailed(false);
    try {
      await htmlBook.rendition.goToTxtChapter(row.chapterId, row.index);
    } catch {
      handleCurrentChapter(previous.currentChapter);
      handleCurrentChapterIndex(previous.currentChapterIndex);
      setJumpFailed(true);
    } finally { jumping.current = false; }
  };

  return <div className="book-content-container txt-content-container" data-txt-virtual-contents="true">
    <div className="book-content-header">
      <div>{t("Total chapters")}: {directory?.chapters.length ?? 0}</div>
      <button type="button" className="book-content-expand" onClick={() => {
        releaseIme();
        setSearchOpen(!searchOpen);
        if (searchOpen) { setDraft(""); setKeyword(""); }
      }}><span className="icon-search" />{t(searchOpen ? "Cancel" : "Search")}</button>
    </div>
    {searchOpen && <div className="book-content-search"><input ref={input}
      className="book-content-search-input" aria-label={t("Search chapters...")}
      placeholder={t("Search chapters...")} value={draft}
      onChange={(event) => { setDraft(event.target.value); if (!composing.current) setKeyword(event.target.value); }}
      onCompositionStart={() => {
        composing.current = true;
        if (ConfigService.getReaderConfig("isNavLocked") !== "yes") {
          ConfigService.setReaderConfig("isTempLocked", "yes");
          ConfigService.setReaderConfig("isNavLocked", "yes");
          ownsImeLock.current = true;
        }
      }}
      onCompositionEnd={(event) => { setDraft(event.currentTarget.value); setKeyword(event.currentTarget.value); releaseIme(); }}
      onBlur={releaseIme} /></div>}
    {failed && <div role="alert">{t("Failed to load chapters")} <button type="button" onClick={() => setRetry((n) => n + 1)}>{t("Retry")}</button></div>}
    {jumpFailed && <div role="alert">{t("Unable to open chapter")}</div>}
    {!directory && !failed && <div role="status">{t("Loading")}</div>}
    <div ref={scroller} className="txt-content-viewport" aria-label={t("Total chapters")}>
      {directory && !rows.length && <div className="book-content-search-empty">{t("No results found")}</div>}
      <ul className="txt-content-rows" style={{ height: range.totalHeight }}>
        {rows.slice(range.start, range.end).map((row, offset) => <li key={row.chapterId}
          className="txt-content-row" data-chapter-index={row.index} data-chapter-id={row.chapterId}
          style={{ top: (range.start + offset) * TXT_ROW_HEIGHT }}>
          <button type="button" className="book-content-name content-chapter-title"
            aria-current={row.index === Number(currentIndex) ? "location" : undefined}
            onClick={() => void jump(row)} title={row.label || t("Unknown chapter")}>
            <span className="book-content-title-label">{row.label || t("Unknown chapter")}</span>
            <span className="txt-content-page">{pages[row.index] || ""}</span>
          </button>
        </li>)}
      </ul>
    </div>
  </div>;
}
