import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AnnotationService,
  AnnotationEntity,
  AnnotationKind,
} from "../../utils/storage/annotationService";
import { useAppStore } from "../../store/useAppStore";
import AnnotationEditor from "./editor";
import "./annotations.css";
const labels = {
  small: "Small annotation",
  chapter: "Chapter annotation",
  range: "Range annotation",
};
export default function AnnotationWorkspace() {
  const { t } = useTranslation(),
    books = useAppStore((s) => s.manager.books);
  const [rows, setRows] = useState<AnnotationEntity[]>([]),
    [kind, setKind] = useState(""),
    [book, setBook] = useState(""),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [more, setMore] = useState(false),
    [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<{
    key?: string;
    kind: AnnotationKind;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void AnnotationService.list({
      kind: kind || undefined,
      bookKey: book || undefined,
      keyword: query,
      offset: page * 50,
      limit: 50,
    }).then((result) => {
      if (active) {
        setRows(result.records);
        setMore(result.hasMore);
      }
    });
    return () => {
      active = false;
    };
  }, [kind, book, query, page, revision]);
  return (
    <main className="annotation-workspace">
      <header>
        <h2>{t("Annotations")}</h2>
        {Object.entries(labels).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setEditing({ kind: value as AnnotationKind })}
          >
            {t("New")} {t(label)}
          </button>
        ))}
      </header>
      <div className="annotation-filters">
        <input
          aria-label={t("Search annotations")}
          placeholder={t("Search annotations")}
          value={query}
          onChange={(event) => {
            setPage(0);
            setQuery(event.target.value);
          }}
        />
        <select
          aria-label={t("Annotation type")}
          value={kind}
          onChange={(event) => {
            setPage(0);
            setKind(event.target.value);
          }}
        >
          <option value="">{t("All types")}</option>
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
        <select
          aria-label={t("Book")}
          value={book}
          onChange={(event) => {
            setPage(0);
            setBook(event.target.value);
          }}
        >
          <option value="">{t("All books")}</option>
          {books.map((item) => (
            <option key={item.key} value={item.key}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <ul className="annotation-entities">
        {rows.map((note) => (
          <li key={note.key}>
            <button
              onClick={() => setEditing({ key: note.key, kind: note.kind })}
            >
              <strong>
                {note.title ||
                  note.notes ||
                  note.text ||
                  t("Unbound annotation")}
              </strong>
              <span>
                {t(labels[note.kind])} ·{" "}
                {books.find((b) => b.key === note.bookKey)?.name ||
                  t("Unknown book")}
              </span>
              <span>{note.tag.join(", ")}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="annotation-actions">
        <button disabled={page === 0} onClick={() => setPage(page - 1)}>
          {t("Previous")}
        </button>
        <button disabled={!more} onClick={() => setPage(page + 1)}>
          {t("Next")}
        </button>
      </div>
      {editing && (
        <div className="annotation-modal">
          <AnnotationEditor
            key={editing.key || editing.kind}
            noteKey={editing.key}
            kind={editing.kind}
            bookKey={book || undefined}
            onSaved={() => setRevision((r) => r + 1)}
            onClose={() => {
              setEditing(null);
              setRevision((r) => r + 1);
            }}
          />
        </div>
      )}
    </main>
  );
}
