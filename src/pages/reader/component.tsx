import { useLatest } from "../../utils/hooks/useLatest";
import { useEffect, useRef, useState } from "react";
import SettingPanel from "../../containers/panels/settingPanel";
import NavigationPanel from "../../containers/panels/navigationPanel";
import { Toaster } from "react-hot-toast";
import {
  ConfigService,
  ReadingTimeUtil,
} from "../../assets/lib/kookit-extra-browser.min";
import Viewer from "../../containers/viewer";
import { Tooltip } from "react-tooltip";
import "./index.css";
import Book from "../../models/Book";
import DatabaseService from "../../utils/storage/databaseService";
import ConvertDialog from "../../components/dialogs/convertDialog";
import ScalePageDialog from "../../components/dialogs/scalePageDialog";
import PdfCropDialog from "../../components/dialogs/pdfCropDialog";
import StudyLangDialog from "../../components/dialogs/studyLangDialog";
import AssistReadDialog from "../../components/dialogs/assistReadDialog";
import { isElectron } from "react-device-detect";
import SettingDialog from "../../components/dialogs/settingDialog";
import SpeechDialog from "../../components/dialogs/speechDialog";
import KeepMounted from "../../components/keepMounted";
import AnnotationDialog from "../../components/dialogs/annotationDialog";
import {
  updateDiscordPresence,
  clearDiscordPresence,
} from "../../utils/reader/discordRPC";
import SupportDialog from "../../components/dialogs/supportDialog";
import ReaderSideToolbar from "../../components/readerSideToolbar";
import { READING_PANEL_TOGGLE_EVENT } from "../../utils/reader/mouseEvent";
import { isPaginatedBook } from "../../utils/common";
import { useAppStore } from "../../store/useAppStore";

export interface ReaderState {
  isOpenRightPanel: boolean;
  isOpenLeftPanel: boolean;
  totalDuration: number;
}

declare var window: any;
const PANEL_POSITIONS = ["left", "right"] as const;
type PanelPosition = (typeof PANEL_POSITIONS)[number];
const PANEL_OPEN_STATE: Record<
  PanelPosition,
  "isOpenLeftPanel" | "isOpenRightPanel"
> = {
  left: "isOpenLeftPanel",
  right: "isOpenRightPanel",
};
const Reader = () => {
  const currentBook = useAppStore((s) => s.book.currentBook);
  const htmlBook = useAppStore((s) => s.reader.htmlBook);
  const readerMode = useAppStore((s) => s.reader.readerMode);
  const isNavLocked = useAppStore((s) => s.reader.isNavLocked);
  const isConvertOpen = useAppStore((s) => s.reader.isConvertOpen);
  const isScaleOpen = useAppStore((s) => s.reader.isScaleOpen);
  const isPdfCropOpen = useAppStore((s) => s.reader.isPdfCropOpen);
  const isStudyLangOpen = useAppStore((s) => s.reader.isStudyLangOpen);
  const isAssistReadOpen = useAppStore((s) => s.reader.isAssistReadOpen);
  const isSpeechOpen = useAppStore((s) => s.reader.isSpeechOpen);
  const isAnnotationOpen = useAppStore((s) => s.reader.isAnnotationOpen);
  const isSettingLocked = useAppStore((s) => s.reader.isSettingLocked);
  const isSettingOpen = useAppStore((s) => s.manager.isSettingOpen);
  const handleFetchBooks = useAppStore((s) => s.handleFetchBooks);
  const handleReadingBook = useAppStore((s) => s.handleReadingBook);
  const handleFetchPercentage = useAppStore((s) => s.handleFetchPercentage);
  const handleReaderMode = useAppStore((s) => s.handleReaderMode);
  const handleMenuMode = useAppStore((s) => s.handleMenuMode);
  const handleOriginalText = useAppStore((s) => s.handleOriginalText);
  const handleOpenMenu = useAppStore((s) => s.handleOpenMenu);
  const handleFetchAuthed = useAppStore((s) => s.handleFetchAuthed);
  const handleFetchUserInfo = useAppStore((s) => s.handleFetchUserInfo);
  const handleBackgroundColor = useAppStore((s) => s.handleBackgroundColor);
  const currentProps = {
    currentBook,
    htmlBook,
    readerMode,
    isNavLocked,
    isConvertOpen,
    isScaleOpen,
    isPdfCropOpen,
    isStudyLangOpen,
    isAssistReadOpen,
    isSpeechOpen,
    isAnnotationOpen,
    isSettingLocked,
    isSettingOpen,
    handleFetchBooks,
    handleReadingBook,
    handleFetchPercentage,
    handleReaderMode,
    handleMenuMode,
    handleOriginalText,
    handleOpenMenu,
    handleFetchAuthed,
    handleFetchUserInfo,
    handleBackgroundColor,
  };
  const propsRef = useLatest(currentProps);
  const [state, setState] = useState<ReaderState>({
    isOpenLeftPanel: isNavLocked,
    isOpenRightPanel: isSettingLocked && !isNavLocked,
    totalDuration: 0,
  });
  const stateRef = useLatest(state);
  const updateState = (patch: Partial<ReaderState>) =>
    setState((prev) => ({ ...prev, ...patch }));
  const tickTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => {
    const rendition = htmlBook?.rendition;
    if (typeof rendition?.applyAnnotationConfig !== "function") return;
    rendition.applyAnnotationConfig({
      isDrawing: isAnnotationOpen ? "yes" : "no",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnnotationOpen, htmlBook]);
  const readingTimeUtilRef = useRef<InstanceType<
    typeof ReadingTimeUtil
  > | null>(null);
  if (!readingTimeUtilRef.current) {
    readingTimeUtilRef.current = new ReadingTimeUtil(
      ConfigService,
      isElectron
        ? {
            registerUnloadHandler(callback: () => void): () => void {
              const ipcRenderer = window.electronAPI;
              // Separate reader window close
              ipcRenderer.on("before-reader-close", callback);
              // In-app tab (WebContentsView) close
              ipcRenderer.on("before-tab-close", callback);
              return () => {
                ipcRenderer.removeListener("before-reader-close", callback);
                ipcRenderer.removeListener("before-tab-close", callback);
              };
            },
            onBeforeClose(): void {
              const ipcRenderer = window.electronAPI;
              // ReadingTimeUtil has persisted progress before this callback.
              // Release TXT sessions/DOM before acknowledging the two-stage close.
              const rendition = propsRef.current.htmlBook?.rendition;
              const ready = () => {
                ipcRenderer.send("reader-close-ready");
                ipcRenderer.send("tab-close-ready");
              };
              if (rendition?.format === "TXT") void Promise.resolve(rendition.removeContent()).then(ready, ready);
              else ready();
            },
          }
        : {
            registerUnloadHandler(callback: () => void): () => void {
              window.addEventListener("beforeunload", callback);
              return () => window.removeEventListener("beforeunload", callback);
            },
          }
    );
  }

  // "left" remains the existing navigation command name; both panels live on the right.
  const handleEnterReader = (position: string) => {
    if (position === "left") {
      updateState({ isOpenLeftPanel: true, isOpenRightPanel: false });
    } else if (position === "right") {
      updateState({ isOpenLeftPanel: false, isOpenRightPanel: true });
    }
  };
  const handleLeaveReader = (position: string) => {
    if (position === "left" && stateRef.current.isOpenLeftPanel) {
      updateState({ isOpenLeftPanel: false });
    } else if (position === "right" && stateRef.current.isOpenRightPanel) {
      updateState({ isOpenRightPanel: false });
    }
  };
  const handleOutsidePanelClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    // Toolbar buttons switch/toggle panels themselves, without a second close.
    if (target instanceof Element && target.closest(".reader-side-toolbar button")) return;
    const activePanel = stateRef.current.isOpenLeftPanel
      ? document.getElementById("reader-navigation-panel")
      : stateRef.current.isOpenRightPanel
        ? document.getElementById("reader-settings-panel")
        : null;
    if (!activePanel || activePanel.contains(target)) return;
    handleLeaveReader("left");
    handleLeaveReader("right");
  };
  const handleReadingPanelToggle = (event: Event) => {
    const position = (event as CustomEvent<{ position: string }>).detail
      ?.position;
    if (!PANEL_POSITIONS.includes(position as PanelPosition)) return;
    const stateKey = PANEL_OPEN_STATE[position as PanelPosition];
    if (stateRef.current[stateKey]) {
      handleLeaveReader(position);
    } else {
      handleEnterReader(position);
    }
  };
  useEffect(() => {
    const run = async () => {
      let url = document.location.href;
      let firstIndexOfQuestion = url.indexOf("?");
      let lastIndexOfSlash = url.lastIndexOf("/", firstIndexOfQuestion);
      let key = url.substring(lastIndexOfSlash + 1, firstIndexOfQuestion);
      if (ConfigService.getAllListConfig("seperateStyleBooks").includes(key)) {
        window.currentBookKey = key;
        propsRef.current.handleBackgroundColor(
          ConfigService.getReaderConfig("backgroundColor") || ""
        );
      } else {
        window.currentBookKey = "";
      }
      propsRef.current.handleFetchBooks();
      propsRef.current.handleFetchAuthed();
      if (
        key &&
        ConfigService.getAllListConfig("convertPDFBooks").includes(key) &&
        ConfigService.getReaderConfig(
          propsRef.current.currentBook?.description?.indexOf("scanned") > -1
            ? "scannedOcrEngine"
            : "textOcrEngine"
        ) === "official-ai-ocr"
      ) {
        await propsRef.current.handleFetchUserInfo();
      }
      DatabaseService.getRecord(key, "books").then((book: Book | null) => {
        book = book || JSON.parse(ConfigService.getItem("tempBook") || "{}");
        if (!book) return;

        propsRef.current.handleFetchPercentage(book);
        let readerMode = isPaginatedBook(book)
          ? ConfigService.getReaderConfig("pdfReaderMode") || "scroll"
          : ConfigService.getReaderConfig("readerMode") || "double";
        propsRef.current.handleReaderMode(readerMode);
        propsRef.current.handleReadingBook(book);
        // Start event-driven reading-time tracking
        readingTimeUtilRef.current!.start(book.key);
        // Initialise UI duration from persisted total
        const savedTotal = readingTimeUtilRef.current!.getTotalSeconds(
          book.key
        );
        updateState({ totalDuration: savedTotal });
        if (isElectron) {
          updateDiscordPresence(book);
        }
      });
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ConfigService.getReaderConfig("isMergeWord") === "yes") {
      document.documentElement.style.backgroundColor = "transparent";
      document
        .querySelector("body")
        ?.setAttribute("style", "background-color: rgba(0,0,0,0)");
    }

    // Update UI counters every second so the navigation panel still shows
    // live reading-time values, but actual storage writes only happen when
    // a reading session ends (visibility hidden / blur / unmount).
    tickTimerRef.current = setInterval(() => {
      if (!propsRef.current.currentBook.key) return;
      setState((prev) => ({
        ...prev,
        totalDuration: prev.totalDuration + 60,
      }));
    }, 60000);

    window.addEventListener("beforeunload", function () {
      if (!isElectron) {
        ConfigService.setReaderConfig("isFinishWebReading", "yes");
      }
    });
    document.addEventListener("click", handleOutsidePanelClick, true);
    window.addEventListener(
      READING_PANEL_TOGGLE_EVENT,
      handleReadingPanelToggle
    );

    return () => {
      document.removeEventListener("click", handleOutsidePanelClick, true);
      window.removeEventListener(
        READING_PANEL_TOGGLE_EVENT,
        handleReadingPanelToggle
      );
      if (isElectron) {
        clearDiscordPresence();
      }
      if (tickTimerRef.current) {
        clearInterval(tickTimerRef.current);
      }
      // Flush any in-flight session time before the component tears down
      readingTimeUtilRef.current!.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isSeparateElectronWindow =
    isElectron && ConfigService.getReaderConfig("isOpenInMain") !== "yes";
  const renditionProps = {
    handleLeaveReader: handleLeaveReader,
    handleEnterReader: handleEnterReader,
    isShow: state.isOpenLeftPanel || state.isOpenRightPanel,
    isPanelLayout: true,
  };
  return (
    <div className="viewer">
      <div className="reader-workspace">
        <div className="reader-main">
          <Tooltip id="my-tooltip" style={{ zIndex: 25 }} />
          {isSeparateElectronWindow && (
            <div className="reader-window-drag-region" />
          )}

          {/* The old top/bottom toolbars are no longer mounted. Only directory
              command targets remain for the existing navigation event route. */}
          <div className="reader-panel-command-targets" hidden>
            <div className="left-panel" onClick={() => handleEnterReader("left")} />
            <div className="right-panel" onClick={() => handleEnterReader("right")} />
          </div>

          {isSettingOpen && (
            <>
              <SettingDialog />
              <div className="drag-background"></div>
            </>
          )}
          <Toaster
            toastOptions={{
              style: {
                padding: "8px 10px",
                wordWrap: "break-word",
                wordBreak: "break-word",
                whiteSpace: "normal",
                overflowWrap: "break-word",
              },
            }}
          />

          {currentBook.key && <Viewer {...(renditionProps as any)} />}
          <div className="reader-setting-dialog-anchor">
            {(readerMode === "scroll" || readerMode === "single") && (
              <KeepMounted open={isScaleOpen}>
                <ScalePageDialog />
              </KeepMounted>
            )}
            <KeepMounted open={isConvertOpen}>
              <ConvertDialog />
            </KeepMounted>
            <KeepMounted open={isPdfCropOpen}>
              <PdfCropDialog />
            </KeepMounted>
            <KeepMounted open={isStudyLangOpen}>
              <StudyLangDialog />
            </KeepMounted>
            <KeepMounted open={isAssistReadOpen}>
              <AssistReadDialog />
            </KeepMounted>
            <KeepMounted open={isSpeechOpen}>
              <SpeechDialog />
            </KeepMounted>
          </div>
          {isAnnotationOpen && <AnnotationDialog />}
          <SupportDialog />
        </div>
        <div
          id="reader-settings-panel"
          className="setting-panel-container"
          hidden={!state.isOpenRightPanel}
          inert={!state.isOpenRightPanel}
        >
          <SettingPanel />
        </div>
        <div
          id="reader-navigation-panel"
          className="navigation-panel-container"
          hidden={!state.isOpenLeftPanel}
          inert={!state.isOpenLeftPanel}
        >
          <NavigationPanel
            totalDuration={state.totalDuration}
            isOpen={state.isOpenLeftPanel}
          />
        </div>
      </div>
      <ReaderSideToolbar
        isNavigationOpen={state.isOpenLeftPanel}
        isSettingsOpen={state.isOpenRightPanel}
      />
    </div>
  );
};

export default Reader;
