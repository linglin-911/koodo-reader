import TxtContentList from "./txtContentList";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./contentList.css";
import { ConfigService } from "../../../assets/lib/kookit-extra-browser.min";
import { Trans } from "react-i18next";
import i18n from "../../../i18n";
import { useAppStore } from "../../../store/useAppStore";
import { scrollContents } from "../../../utils/common";

export interface ContentListState {
  chapters: any;

  isExpandContent: boolean;
  expandedItems: Set<string>;
  isSearchOpen: boolean;
  searchKeyword: string;
  isComposing: boolean;
  chapterPages: number[];
}

interface FlatChapterItem {
  item: any;
  level: number;
  path: string;
}

interface ContentListProps {
  isActive: boolean;
}

const TreeContentList = ({ isActive }: ContentListProps) => {
  const currentBook = useAppStore((s) => s.book.currentBook);
  const htmlBook = useAppStore((s) => s.reader.htmlBook);
  const handleCurrentChapter = useAppStore((s) => s.handleCurrentChapter);
  const handleCurrentChapterIndex = useAppStore(
    (s) => s.handleCurrentChapterIndex
  );
  const handleJumpPosition = useAppStore((s) => s.handleJumpPosition);
  const [state, setState] = useState<ContentListState>(() => ({
    chapters: [],
    expandedItems: new Set<string>(), // 存储展开的项目路径
    isExpandContent: ConfigService.getReaderConfig("isExpandContent") === "yes",
    isSearchOpen: false,
    searchKeyword: "",
    isComposing: false,
    chapterPages: [],
  }));

  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingOpenAlignmentRef = useRef<{
    bookKey: string;
    chapterTitle: string;
    chapterHref: string;
  } | null>(null);
  const pendingCenterScrollRef = useRef<{
    title: string;
    href: string;
  } | null>(null);

  const findAndExpandCurrentChapter = (
    chapters: any[],
    location: { chapterTitle: string; chapterHref: string }
  ): Set<string> => {
    const expandedPaths = new Set<string>();

    const matchesCurrentChapter = (item: any): boolean => {
      if (location.chapterHref && typeof item.href === "string") {
        const baseHref = item.href.split("#")[0];
        return (
          item.href === location.chapterHref ||
          (!!baseHref && location.chapterHref.includes(baseHref))
        );
      }
      return item.label === location.chapterTitle;
    };

    const containsCurrentChapter = (item: any): boolean =>
      matchesCurrentChapter(item) ||
      (Array.isArray(item.subitems) &&
        item.subitems.some(containsCurrentChapter));

    const visit = (items: any[], parentPath = "") => {
      items.forEach((item, index) => {
        const currentPath = parentPath
          ? `${parentPath}-${index}`
          : `${index}`;

        if (Array.isArray(item.subitems) && item.subitems.length > 0) {
          if (item.subitems.some(containsCurrentChapter)) {
            expandedPaths.add(currentPath);
          }
          visit(item.subitems, currentPath);
        }
      });
    };

    visit(chapters);
    return expandedPaths;
  };

  const flattenChaptersWithLevel = (
    items: any[],
    level: number = 1,
    parentPath: string = ""
  ): FlatChapterItem[] => {
    const result: FlatChapterItem[] = [];
    items.forEach((item, index) => {
      const currentPath = parentPath ? `${parentPath}-${index}` : `${index}`;
      result.push({ item, level, path: currentPath });
      if (item.subitems && item.subitems.length > 0) {
        result.push(
          ...flattenChaptersWithLevel(item.subitems, level + 1, currentPath)
        );
      }
    });
    return result;
  };

  const getSearchResults = (): FlatChapterItem[] => {
    const keyword = state.searchKeyword.trim().toLowerCase();
    if (!keyword) {
      return [];
    }
    return flattenChaptersWithLevel(state.chapters).filter(({ item }) =>
      item.label.toLowerCase().includes(keyword)
    );
  };

  const toggleSearch = () => {
    const isSearchOpen = !state.isSearchOpen;
    setState((prev) => ({
      ...prev,
      isSearchOpen,
      searchKeyword: isSearchOpen ? prev.searchKeyword : "",
      isComposing: false,
    }));
  };

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setState((prev) => ({ ...prev, searchKeyword: event.target.value }));
  };

  const handleCompositionStart = () => {
    setState((prev) => ({ ...prev, isComposing: true }));
    ConfigService.setReaderConfig("isTempLocked", "yes");
    ConfigService.setReaderConfig("isNavLocked", "yes");
  };

  const handleCompositionEnd = (
    event: React.CompositionEvent<HTMLInputElement>
  ) => {
    setState((prev) => ({
      ...prev,
      isComposing: false,
      searchKeyword: event.currentTarget.value,
    }));
    if (ConfigService.getReaderConfig("isTempLocked") === "yes") {
      ConfigService.setReaderConfig("isNavLocked", "");
      ConfigService.setReaderConfig("isTempLocked", "");
    }
  };

  const handleSearchJump = async (item: any) => {
    await handleJump(item);
  };

  function updateChapterData(htmlBook: any) {
    setState((prev) => ({
      ...prev,
      chapters: htmlBook.chapters,
      chapterPages: htmlBook.rendition.getPages(),
    }));
  }

  async function handleJump(item: any) {
    const prevPosition = ConfigService.getObjectConfig(
      currentBook.key,
      "recordLocation",
      {}
    );
    handleJumpPosition(prevPosition);
    // 原逻辑会把刚跳转的章节滚到目录顶部；现在只更新标识，不改变用户的目录浏览位置。
    // scrollContents(item.label, item.href);
    scrollContents(item.label, item.href, false);
    await htmlBook.rendition.goToChapter(item.index, item.href, item.label);
    handleCurrentChapter(item.label);
    handleCurrentChapterIndex(item.index);
  }

  useEffect(() => {
    if (!htmlBook) return;

    updateChapterData(htmlBook);
    const handleChapterPages = () => updateChapterData(htmlBook);
    htmlBook.rendition.on("chapter-pages", handleChapterPages);

    return () => {
      htmlBook.rendition.off("chapter-pages", handleChapterPages);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [htmlBook]);

  useEffect(() => {
    if (!isActive) {
      pendingOpenAlignmentRef.current = null;
      pendingCenterScrollRef.current = null;
      return;
    }

    const location = ConfigService.getObjectConfig(
      currentBook.key,
      "recordLocation",
      {}
    );
    pendingOpenAlignmentRef.current = {
      bookKey: currentBook.key,
      chapterTitle: location.chapterTitle || "",
      chapterHref: location.chapterHref || "",
    };
  }, [isActive, currentBook.key, htmlBook]);

  useEffect(() => {
    const pending = pendingOpenAlignmentRef.current;
    if (
      !isActive ||
      !pending ||
      pending.bookKey !== currentBook.key ||
      !htmlBook ||
      state.chapters !== htmlBook.chapters ||
      !state.chapters.length
    ) {
      return;
    }

    pendingCenterScrollRef.current = {
      title: pending.chapterTitle,
      href: pending.chapterHref,
    };
    pendingOpenAlignmentRef.current = null;
    const currentChapterPaths = findAndExpandCurrentChapter(
      state.chapters,
      pending
    );
    setState((prev) => ({
      ...prev,
      expandedItems: new Set([...prev.expandedItems, ...currentChapterPaths]),
    }));
  }, [isActive, currentBook.key, htmlBook, state.chapters]);

  useLayoutEffect(() => {
    const pending = pendingCenterScrollRef.current;
    if (!isActive || !pending) return;

    pendingCenterScrollRef.current = null;
    scrollContents(pending.title, pending.href, true, "center");
  }, [isActive, state.expandedItems]);

  useEffect(() => {
    if (state.isSearchOpen) {
      searchInputRef.current?.focus();
    }
  }, [state.isSearchOpen]);

  const renderContentList = (
    items: any,
    level: number,
    parentPath: string = ""
  ) => {
    level++;
    return items.map((item: any, index: number) => {
      const currentPath = parentPath ? `${parentPath}-${index}` : `${index}`;
      const isExpanded = state.expandedItems.has(currentPath);

      return (
        <li key={index} className="book-content-list">
          {item.subitems &&
            item.subitems.length > 0 &&
            !state.isExpandContent && (
              <span
                className="icon-dropdown content-dropdown"
                onClick={() => {
                  const newExpandedItems = new Set(state.expandedItems);
                  if (isExpanded) {
                    newExpandedItems.delete(currentPath);
                  } else {
                    newExpandedItems.add(currentPath);
                  }
                  setState((prev) => ({
                    ...prev,
                    expandedItems: newExpandedItems,
                  }));
                }}
                style={isExpanded ? {} : { transform: "rotate(-90deg)" }}
              ></span>
            )}

          <div
            onClick={() => {
              handleJump(item);
            }}
            className="book-content-name content-chapter-title"
            data-href={item.href}
          >
            <span className="book-content-title-label" data-href={item.href}>
              {item.label}
            </span>
            <span
              style={{ marginRight: "20px", opacity: 0.6, fontSize: "12px" }}
            >
              {state.chapterPages[item.index]
                ? state.chapterPages[item.index]
                : ""}
            </span>
          </div>
          {item.subitems &&
          item.subitems.length > 0 &&
          (isExpanded || state.isExpandContent) ? (
            <ul>{renderContentList(item.subitems, level, currentPath)}</ul>
          ) : null}
        </li>
      );
    });
  };
  const searchResults = getSearchResults();
  const isSearching =
    state.searchKeyword.trim().length > 0 && !state.isComposing;
  const renderSearchResults = () => {
    if (searchResults.length === 0) {
      return (
        <li className="book-content-list book-content-search-empty">
          <Trans>No results found</Trans>
        </li>
      );
    }
    return searchResults.map(({ item, level, path }) => (
      <li
        key={path}
        className="book-content-list"
        style={{ marginLeft: `${level * 15}px` }}
      >
        <span
          onClick={() => {
            handleSearchJump(item);
          }}
          className="book-content-name"
          data-href={item.href}
        >
          {item.label}
        </span>
      </li>
    ));
  };

  return (
    <div className="book-content-container">
      {htmlBook && (
        <div className="book-content-header">
          <div>
            <Trans>Total chapters</Trans>:
            {htmlBook.flattenChapters.length}
          </div>
          <div style={{ display: "flex", gap: "0px" }}>
            <div onClick={toggleSearch} className="book-content-expand">
              <span
                className="icon-search"
                style={{ paddingRight: "5px" }}
              ></span>
              <Trans>{state.isSearchOpen ? "Cancel" : "Search"}</Trans>
            </div>
            <div
              onClick={() => {
                ConfigService.setReaderConfig(
                  "isExpandContent",
                  state.isExpandContent ? "no" : "yes"
                );
                setState((prev) => ({
                  ...prev,
                  isExpandContent: !prev.isExpandContent,
                }));
              }}
              className="book-content-expand"
            >
              <span className="icon-collapse"></span>
              {state.isExpandContent ? (
                <Trans>Collapse</Trans>
              ) : (
                <Trans>Expand</Trans>
              )}
            </div>
          </div>
        </div>
      )}
      {state.isSearchOpen && (
        <div className="book-content-search">
          <input
            ref={searchInputRef}
            className="book-content-search-input"
            value={state.searchKeyword}
            onChange={handleSearchChange}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder={i18n.t("Search chapters...")}
          />
        </div>
      )}
      <ul className="book-content">
        {isSearching
          ? renderSearchResults()
          : state.chapters && renderContentList(state.chapters, 1, "")}
      </ul>
    </div>
  );
};

const ContentList = (props: ContentListProps) => {
  const currentBook = useAppStore((s) => s.book.currentBook);
  const htmlBook = useAppStore((s) => s.reader.htmlBook);
  return currentBook.format === "TXT" && htmlBook?.rendition?.getTxtDirectory &&
    ConfigService.getReaderConfig("isDisableTxtVirtualContents") !== "yes"
    ? <TxtContentList key={currentBook.key} {...props} />
    : <TreeContentList {...props} />;
};
export default ContentList;
