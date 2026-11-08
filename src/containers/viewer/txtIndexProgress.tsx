import { useTranslation } from "react-i18next";
import type { TxtBuildProgress } from "../../utils/storage/txtIndexService";
import "./index.css";
export default function TxtIndexProgress({ progress, cancel, retry, locate }: {
  progress: TxtBuildProgress; cancel: () => void; retry: () => void; locate?: () => void;
}) {
  const { t } = useTranslation();
  const stopped = progress.state === "failed" || progress.state === "cancelled";
  return <section className="txt-index-progress" aria-label={t("Preparing chapters")}>
    <div role="status">{t(progress.state === "failed" ? "Failed to load chapters" : progress.state === "cancelled" ? "Cancelled" : progress.state === "recovering" ? "Recovering annotation locations" : "Preparing chapters")}
      {!stopped && <progress max={progress.total || 1} value={progress.bytes || 0} />}
      <button type="button" onClick={stopped ? retry : cancel}>{t(stopped ? "Retry" : "Cancel")}</button>
    </div>
    {progress.reason === "source-missing" && <><p>{t("Original TXT source is missing")}</p>{locate && <button onClick={locate}>{t("Locate original TXT")}</button>}</>}
    {progress.reason && progress.reason !== "source-missing" && <p>{t(progress.reason === "line-limit" ? "This chapter parser cannot process lines longer than 65536 characters. Choose the default parser." : "Chapter preparation timed out. Check the chapter parser and retry.")}</p>}
    {progress.preview && <><div>{t("Temporary preview")}</div><pre>{progress.preview}</pre></>}
  </section>;
}
