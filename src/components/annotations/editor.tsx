import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import {
  AnnotationService,
  AnnotationBinding,
  AnnotationEntity,
  AnnotationKind,
  BindingInput,
} from "../../utils/storage/annotationService";
import { openPersistentTxt } from "../../utils/storage/txtIndexService";
import {
  captureAnnotation,
  notifyAnnotations,
} from "../../utils/reader/annotationUtil";
import { getParserRegex } from "../../utils/common";
import { useAppStore } from "../../store/useAppStore";
import ColorOption from "../colorOption";
import {
  HighlightUtil,
  ConfigService,
} from "../../assets/lib/kookit-extra-browser.min";
import "./annotations.css";
const names = {
  small: "Small annotation",
  chapter: "Chapter annotation",
  range: "Range annotation",
};
interface Props {
  noteKey?: string;
  kind?: AnnotationKind;
  bookKey?: string;
  selection?: boolean;
  append?: boolean;
  bindingId?: string;
  chapterIndex?: number;
  chapter?: string;
  onClose: () => void;
  onSaved?: () => void;
}
const highlightUtil = new HighlightUtil(ConfigService);
export default function AnnotationEditor(props: Props) {
  const { t } = useTranslation();
  const books = useAppStore((s) => s.manager.books),
    currentBook = useAppStore((s) => s.book.currentBook),
    htmlBook = useAppStore((s) => s.reader.htmlBook),
    highlight = useAppStore((s) => s.reader.highlight);
  const [note, setNote] = useState<AnnotationEntity | null>(null),
    [kind, setKind] = useState<AnnotationKind>(props.kind || "small");
  const [bookKey, setBookKey] = useState(
      props.bookKey || currentBook?.key || books[0]?.key || ""
    ),
    [title, setTitle] = useState(""),
    [body, setBody] = useState(""),
    [tagText, setTagText] = useState("");
  const [choiceQuery, setChoiceQuery] = useState(""),
    [choiceOffset, setChoiceOffset] = useState(0),
    [choiceMore, setChoiceMore] = useState(false);
  const [choices, setChoices] = useState<AnnotationEntity[]>([]),
    [selected, setSelected] = useState(props.noteKey || ""),
    [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<Awaited<
      ReturnType<typeof openPersistentTxt>
    > | null>(null),
    [chapters, setChapters] = useState<
      Array<{ index: number; label: string; chapterId: string }>
    >([]);
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(0),
    [related, setRelated] = useState<AnnotationEntity[]>([]);
  const sourceRef = useRef<typeof catalog>(null),
    anchorRef = useRef<BindingInput | null>(null);
  const apply = (value: AnnotationEntity) => {
    setNote(value);
    setKind(value.kind);
    setBookKey(value.bookKey);
    setTitle(value.title);
    setBody(value.notes);
    setTagText(value.tag.join(", "));
    const binding =
      value.bindings.find((b) => b.id === props.bindingId) ||
      value.bindings.find((b) => b.status !== "unbound");
    if (binding && value.kind === "small")
      useAppStore
        .getState()
        .handleHighlight(highlightUtil.getHighlightValue(binding.style));
  };
  useEffect(() => {
    let active = true;
    (async () => {
      if (props.selection && htmlBook?.rendition) {
        try {
          anchorRef.current = await captureAnnotation(
            currentBook,
            htmlBook.rendition,
            props.chapterIndex || 0,
            props.chapter || "",
            highlightUtil.formatHighlightValue(highlight)
          );
        } catch {
          toast.error(t("Select unchanged chapter body text"));
        }
      }
      if (props.noteKey) {
        const value = await AnnotationService.get(props.noteKey);
        if (active && value) apply(value);
      }
    })().catch(() => toast.error(t("Unable to load annotation")));
    return () => {
      active = false;
      void sourceRef.current?.store?.close();
    };
  }, [props.noteKey]);
  useEffect(() => {
    if (!props.append) return;
    let active = true;
    const timer = setTimeout(() => {
      void AnnotationService.list({
        kind: "small",
        bookKey: props.bookKey || currentBook.key,
        keyword: choiceQuery,
        offset: choiceOffset,
        limit: 100,
      }).then((page) => {
        if (active) {
          setChoices(page.records);
          setChoiceMore(page.hasMore);
        }
      });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [props.append, props.bookKey, currentBook.key, choiceQuery, choiceOffset]);
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
      notifyAnnotations();
      props.onSaved?.();
    } catch {
      toast.error(
        t("Annotation changed or source unavailable; reload and retry")
      );
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const data = {
      key: note?.key,
      version: note?.version,
      bookKey,
      kind,
      title,
      notes: body,
      tag: tagText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    };
    const value = !note && anchorRef.current
      ? await AnnotationService.create(data, {...anchorRef.current,style:highlightUtil.formatHighlightValue(highlight)})
      : await AnnotationService.save(data);
    anchorRef.current = null;
    apply(value);
    toast.success(t("Saved"));
  };
  const loadChapters = async () => {
    const book = books.find((b) => b.key === bookKey) || currentBook;
    if (!book || book.key !== bookKey || book.format !== "TXT")
      throw new Error("TXT chapter source required");
    await sourceRef.current?.store?.close();
    const source = await openPersistentTxt(
      book.key,
      book.path,
      book.charset,
      getParserRegex("TXT", book.key)
    );
    sourceRef.current = source;
    if (!source.store) throw new Error("Unsupported chapter source");
    const { prepareTxtIndex } = await import("../../assets/lib/kookit.min");
    const index = await prepareTxtIndex(
      source.store,
      source.encoding,
      getParserRegex("TXT", book.key)
    );
    setCatalog(source);
    setChapters(index.chapters);
    setStart(index.chapters[0]?.index || 0);
    setEnd(index.chapters[0]?.index || 0);
  };
  const bindChapters = async () => {
    if (!note || !catalog?.store)
      throw new Error("Save and load chapters first");
    const first = chapters.find((c) => c.index === start),
      last = chapters.find((c) => c.index === end);
    if (!first || !last) throw new Error("Missing chapter");
    const previous = note.bindings.find((b) => b.status !== "unbound");
    apply(
      await AnnotationService.bind(
        note.key,
        {
          format: "TXT",
          sourceTicket: catalog.store.sourceTicket,
          chapterIndex: first.index,
          chapterId: first.chapterId,
          endChapterIndex: last.index,
          endChapterId: last.chapterId,
        },
        previous
      )
    );
  };
  const editBinding = async (binding: AnnotationBinding, undo = false) => {
    if (!note) return;
    apply(
      undo
        ? await AnnotationService.undo(
            note.key,
            binding,
            catalog?.store?.sourceTicket ||
              (bookKey === currentBook?.key ? htmlBook?.rendition?.txtIndexStore?.sourceTicket : undefined)
          )
        : await AnnotationService.unlink(note.key, binding)
    );
  };
  return (
    <section className="annotation-editor" aria-label={t(names[kind])}>
      <header>
        <strong>{t(names[kind])}</strong>
        <button onClick={props.onClose}>{t("Close")}</button>
      </header>
      {props.append && (
        <div>
          <input
            aria-label={t("Search existing small annotations")}
            value={choiceQuery}
            onChange={(event) => {
              setChoiceQuery(event.target.value);
              setChoiceOffset(0);
            }}
          />
          <button
            disabled={!choiceOffset}
            onClick={() => setChoiceOffset((value) => Math.max(0, value - 100))}
          >
            {t("Previous")}
          </button>
          <button
            disabled={!choiceMore}
            onClick={() => setChoiceOffset((value) => value + 100)}
          >
            {t("Next")}
          </button>
        </div>
      )}
      {props.append && (
        <label>
          {t("Add to small annotation")}
          <select
            aria-label={t("Choose existing annotation")}
            value={selected}
            onChange={(event) => {
              const key = event.target.value;
              setSelected(key);
              void run(async () => {
                const value = await AnnotationService.get(key);
                if (value) apply(value);
              });
            }}
          >
            <option value="">{t("Please select")}</option>
            {choices.map((item) => (
              <option key={item.key} value={item.key}>
                {item.title || item.notes || item.text || item.key}
              </option>
            ))}
          </select>
        </label>
      )}
      {!note && (
        <label>
          {t("Book")}
          <select
            aria-label={t("Book")}
            value={bookKey}
            onChange={(event) => setBookKey(event.target.value)}
            disabled={props.selection}
          >
            {books.map((book) => (
              <option key={book.key} value={book.key}>
                {book.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t("Title")}
        <input
          aria-label={t("Title")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        {t("Content")}
        <textarea
          aria-label={t("Annotation body")}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void run(save);
            }
          }}
        />
      </label>
      <label>
        {t("Tags")}
        <input
          aria-label={t("Tags")}
          value={tagText}
          onChange={(event) => setTagText(event.target.value)}
        />
      </label>
      {kind === "small" && (
        <div className="annotation-color">
          <ColorOption isEdit={true} handleDigest={() => {}} />
        </div>
      )}
      <div className="annotation-actions">
        <button disabled={busy || !bookKey} onClick={() => void run(save)}>
          {t("Save")}
        </button>
        {note && anchorRef.current && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                apply(
                  await AnnotationService.bind(note.key, {
                    ...anchorRef.current!,
                    style: highlightUtil.formatHighlightValue(highlight),
                  })
                );
                anchorRef.current = null;
              })
            }
          >
            {t("Add location")}
          </button>
        )}
        {note && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await AnnotationService.delete(note);
                props.onClose();
              })
            }
          >
            {t("Delete annotation")}
          </button>
        )}
      </div>
      {kind !== "small" && (
        <fieldset>
          <legend>{t("Chapter binding")}</legend>
          <button disabled={busy} onClick={() => void run(loadChapters)}>
            {t("Load chapters")}
          </button>
          {chapters.length > 0 && (
            <>
              <select
                aria-label={t("Start chapter")}
                value={start}
                onChange={(event) => setStart(Number(event.target.value))}
              >
                {chapters.map((chapter) => (
                  <option key={chapter.chapterId} value={chapter.index}>
                    {chapter.index + 1}. {chapter.label || t("Preamble")}
                  </option>
                ))}
              </select>
              {kind === "range" && (
                <select
                  aria-label={t("End chapter")}
                  value={end}
                  onChange={(event) => setEnd(Number(event.target.value))}
                >
                  {chapters.map((chapter) => (
                    <option key={chapter.chapterId} value={chapter.index}>
                      {chapter.index + 1}. {chapter.label || t("Preamble")}
                    </option>
                  ))}
                </select>
              )}
              <button
                disabled={!note || busy || (kind === "range" && end < start)}
                onClick={() => void run(bindChapters)}
              >
                {t("Set binding")}
              </button>
            </>
          )}
          {catalog?.store && chapters.length > 0 && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const chapter = chapters.find((c) => c.index === start)!;
                  setRelated(
                    (
                      await AnnotationService.list({
                        bookKey,
                        chapterIndex: start,
                        chapterId: chapter.chapterId,
                        sourceTicket: catalog.store!.sourceTicket,
                        limit: 100,
                      })
                    ).records
                  );
                })
              }
            >
              {t("Related annotations")}
            </button>
          )}
          {related.map((item) => (
            <button
              key={item.key}
              onClick={() =>
                void run(async () => {
                  const value = await AnnotationService.get(item.key);
                  if (value) apply(value);
                })
              }
            >
              {item.title || item.notes || item.text || t(names[item.kind])}
            </button>
          ))}
        </fieldset>
      )}
      {note && (
        <section aria-label={t("Bindings")}>
          <h4>{t("Bindings")}</h4>
          {note.bindings.length === 0 && <p>{t("Unbound annotation")}</p>}
          <button
            disabled={
              busy || !note.bindings.some((b) => b.status !== "unbound")
            }
            onClick={() =>
              void run(async () =>
                apply(await AnnotationService.unlinkAll(note))
              )
            }
          >
            {t("Unbind all")}
          </button>
          {note.bindings.map((binding) => (
            <article
              className={
                binding.id === props.bindingId
                  ? "annotation-binding selected"
                  : "annotation-binding"
              }
              key={binding.id}
            >
              <div>
                {binding.anchor.chapter?.label ||
                  binding.anchor.start?.label ||
                  t("Preamble")}
                {binding.kind === "range"
                  ? " → " + (binding.anchor.end?.label || t("Preamble"))
                  : ""}{" "}
                · {t(binding.status)}
              </div>
              <blockquote>{binding.quote}</blockquote>
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    editBinding(binding, binding.status === "unbound")
                  )
                }
              >
                {t(binding.status === "unbound" ? "Undo unbind" : "Unbind")}
              </button>
              {kind === "small" && binding.status !== "unbound" && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      apply(
                        await AnnotationService.style(
                          note.key,
                          binding,
                          highlightUtil.formatHighlightValue(highlight)
                        )
                      )
                    )
                  }
                >
                  {t("Update location style")}
                </button>
              )}
              {kind === "small" &&
                anchorRef.current &&
                binding.status !== "unbound" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        apply(
                          await AnnotationService.bind(
                            note.key,
                            anchorRef.current!,
                            binding
                          )
                        );
                        anchorRef.current = null;
                      })
                    }
                  >
                    {t("Replace this location")}
                  </button>
                )}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
