import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type Book from "../../models/Book";
import { AnnotationService, RecoveryResults } from "../../utils/storage/annotationService";
import { rebuildTxt, relocateTxt } from "../../utils/storage/txtRecoveryService";
import type { TxtBuildProgress } from "../../utils/storage/txtIndexService";
import AnnotationEditor from "./editor";
import "./txtRecovery.css";
const reasons: Record<string, string> = {
  recovered: "Binding recovered", "chapter-missing": "Chapter could not be identified",
  "ambiguous-chapter": "Multiple chapters match", "reversed-range": "Range endpoints changed order",
  "quote-missing": "Original excerpt was not found", "ambiguous-quote": "Multiple excerpts match",
  "invalid-snapshot": "Saved location needs manual review", "concurrent-change": "Binding changed during rebuilding",
};
export default function TxtRecoveryPanel({ book }: { book: Book }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const [result, setResult] = useState<RecoveryResults>({ records: [], counts: {}, hasMore: false });
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState<TxtBuildProgress | null>(null);
  const [error, setError] = useState(""), [done, setDone] = useState(false);
  const [editing, setEditing] = useState<RecoveryResults["records"][number] | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { setPage(0); setDone(false); setError(""); return () => controller.current?.abort(); }, [book.key]);
  useEffect(() => {
    let active = true;
    void AnnotationService.recoveryResults(book.key, page * 50).then(value => { if (active) setResult(value); })
      .catch(() => { if (active) setError(t("Failed to load recovery results")); });
    return () => { active = false; };
  }, [book.key, page, revision, t]);
  const run = async (locate = false) => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setError(""); setDone(false);
    try {
      const options = { signal: current.signal, onProgress: (value: TxtBuildProgress | null) => { if (!current.signal.aborted) setProgress(value); } };
      if (locate) { if (!await relocateTxt(book, options)) return; }
      else await rebuildTxt(book, options);
      if (!current.signal.aborted) { setDone(true); setPage(0); setRevision(value => value + 1); }
    } catch (failure) {
      if (!current.signal.aborted) setError(t(failure instanceof Error && failure.message.includes("TXT_SOURCE_UNAVAILABLE") ? "Original TXT source is missing" : failure instanceof Error && failure.message.includes("TXT_LIBRARY_SOURCE_AVAILABLE") ? "The library original is still available. Use validate and rebuild." : "Rebuild failed. Existing annotations and snapshots were preserved."));
    } finally { if (controller.current === current && !current.signal.aborted) { setBusy(false); setProgress(null); } }
  };
  return <section className="txt-recovery-panel" aria-label={t("TXT validation and recovery")}>
    <h3>{t("TXT validation and recovery")}</h3>
    <p>{t("Validate the full source and rebuild its chapter index. Only unique annotation matches are restored; uncertain locations stay available for manual binding.")}</p>
    <div className="annotation-actions">
      <button disabled={busy} onClick={() => void run()}>{t("Validate and rebuild TXT")}</button>
      <button disabled={busy} onClick={() => void run(true)}>{t("Locate original TXT")}</button>
      {busy && <button onClick={() => { controller.current?.abort(); setBusy(false); setProgress(null); }}>{t("Cancel")}</button>}
    </div>
    {busy && <div role="status">{t(progress?.state === "recovering" ? "Recovering annotation locations" : "Preparing chapters")}<progress max={progress?.total || 1} value={progress?.bytes || 0} /></div>}
    {error && <p role="alert">{error}</p>}
    {done && <p role="status">{t("TXT validation and recovery finished. Reopen the reader to use the rebuilt source.")}</p>}
    <p>{t("Results from the latest rebuild. Locations edited afterward are omitted.")}</p>
    <p>{t("Recovered")}: {result.counts.active || 0} · {t("Pending")}: {result.counts.pending || 0} · {t("Invalid")}: {result.counts.invalid || 0}</p>
    <ul>{result.records.map(row => <li key={row.binding_id}>
      <button onClick={() => setEditing(row)}>{row.title || row.label || t("Unbound annotation")}</button>
      <span>{t(reasons[row.reason] || "Saved location needs manual review")}</span>
    </li>)}</ul>
    <div className="annotation-actions"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>{t("Previous")}</button><span>{page + 1}</span><button disabled={!result.hasMore} onClick={() => setPage(value => value + 1)}>{t("Next")}</button></div>
    {editing && <div className="annotation-modal"><AnnotationEditor noteKey={editing.note_key} kind={editing.kind} bookKey={book.key}
      onSaved={() => setRevision(value => value + 1)} onClose={() => { setEditing(null); setRevision(value => value + 1); }} /></div>}
  </section>;
}
