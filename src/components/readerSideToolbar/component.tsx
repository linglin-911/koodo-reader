import { useTranslation } from "react-i18next";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import { useAppStore } from "../../store/useAppStore";
import { toggleNavTab, toggleReadingPanel } from "../../utils/reader/mouseEvent";
import "./readerSideToolbar.css";

interface ReaderSideToolbarProps {
  isNavigationOpen: boolean;
  isSettingsOpen: boolean;
}

export default function ReaderSideToolbar({
  isNavigationOpen,
  isSettingsOpen,
}: ReaderSideToolbarProps) {
  const { t } = useTranslation();
  const backgroundColor = useAppStore((s) => s.reader.backgroundColor);
  return (
    <nav
      className="reader-side-toolbar"
      aria-label={t("Reader shortcuts")}
      style={{
        backgroundColor: backgroundColor || undefined,
        color: ConfigService.getReaderConfig("textColor") || undefined,
      }}
    >
      <button
        type="button"
        title={t("Content")}
        aria-label={t("Content")}
        aria-expanded={isNavigationOpen}
        aria-controls="reader-navigation-panel"
        onClick={() => toggleNavTab("contents")}
      >
        <span className="icon-list" aria-hidden="true" />
      </button>
      <button
        type="button"
        title={t("Current chapter annotations (coming later)")}
        aria-label={t("Current chapter annotations")}
        disabled
      >
        <span className="icon-note" aria-hidden="true" />
      </button>
      <button
        type="button"
        title={t("Reading settings")}
        aria-label={t("Reading settings")}
        aria-expanded={isSettingsOpen}
        aria-controls="reader-settings-panel"
        onClick={() => toggleReadingPanel("right")}
      >
        <span className="icon-setting" aria-hidden="true" />
      </button>
    </nav>
  );
}
