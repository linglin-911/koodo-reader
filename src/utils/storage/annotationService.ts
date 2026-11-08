import { invokeMeasuredDatabaseCommand, DatabaseReadContext } from "./databaseDiagnostics";
import { getStorageLocation } from "../common";
export type AnnotationKind = "small" | "chapter" | "range";
export interface ChapterSnapshot {
  chapterId: string;
  index: number;
  label: string;
  start: number;
  end: number;
  bodyStart: number;
  firstChars: string;
  lastChars: string;
}
export interface AnnotationBinding {
  id: string;
  note_key: string;
  kind: AnnotationKind;
  book_id: string;
  format: string;
  generation: string | null;
  chapter_id: string | null;
  start_index: number;
  end_index: number;
  status: "active" | "pending" | "invalid" | "unbound";
  version: number;
  style: string;
  quote: string;
  relative_start: number | null;
  relative_end: number | null;
  prefix: string;
  suffix: string;
  anchor: {
    chapter?: ChapterSnapshot;
    start?: ChapterSnapshot;
    end?: ChapterSnapshot;
    documentRevision?: string;
    locator?: { cfi: string; range: string; percentage: string };
  };
}
export interface AnnotationEntity {
  key: string;
  bookKey: string;
  kind: AnnotationKind;
  title: string;
  notes: string;
  tag: string[];
  version: number;
  bindings: AnnotationBinding[];
  date: { year: number; month: number; day: number };
  chapter: string;
  chapterIndex: number;
  text: string;
  cfi: string;
  range: string;
  percentage: string;
  color: string;
}
export interface BindingInput {
  format: string;
  sourceTicket?: string;
  chapterIndex: number;
  chapterId?: string;
  endChapterIndex?: number;
  endChapterId?: string;
  start?: number;
  end?: number;
  style?: string;
  range?: string;
  cfi?: string;
  quote?: string;
  chapter?: string;
  percentage?: string;
}
export const annotationCommand = <T = unknown>(
  action: string,
  data: Record<string, unknown> = {},
  context: DatabaseReadContext = {}
): Promise<T> =>
  invokeMeasuredDatabaseCommand<T>((channel,command)=>window.electronAPI.invoke(channel,command), {
    operation: "annotations",
    dbName: "notes",
    storagePath: getStorageLocation(),
    action,
    ...data,
  }, context);
export interface AnnotationWindowBlock { chapterIndex:number; chapterId:string; start:number; end:number; }
export interface ReadingAnnotation { key:string;entityKey:string;bindingId:string;color:string;hasNote:boolean;notes:string;chapterIndex:number;txtAnchor?:{start:number;end:number}; }
export interface RecoveryResults {
  generation?: string;
  records: Array<{binding_id:string;note_key:string;kind:AnnotationKind;status:string;reason:string;label:string;title:string}>;
  counts: Partial<Record<"active"|"pending"|"invalid",number>>;
  hasMore: boolean;
}
export const AnnotationService = {
  recoveryResults: (bookKey:string,offset=0) => annotationCommand<RecoveryResults>("recovery-results",{bookKey,offset,limit:50}),
  readingWindow: (data: {bookKey:string;format:"TXT";sourceTicket?:string;blocks:AnnotationWindowBlock[];offset:number;afterId?:string}, context:DatabaseReadContext={}) =>
    annotationCommand<{records:ReadingAnnotation[];related:unknown[];hasMore:boolean;nextCursor?:string}>("reading-window",{...data,limit:200},context),
  create: (note:{bookKey:string;kind:AnnotationKind;notes:string;tag:string[];title?:string},binding:BindingInput) =>
    annotationCommand<AnnotationEntity>("create",{note,binding}),
  list: (filter: Record<string, unknown> = {}) =>
    annotationCommand<{ records: AnnotationEntity[]; hasMore: boolean }>(
      "list",
      filter
    ),
  get: (key: string) =>
    annotationCommand<AnnotationEntity | null>("get", { key }),
  save: (
    note: Partial<AnnotationEntity> & {
      bookKey: string;
      kind: AnnotationKind;
      notes: string;
      tag: string[];
    }
  ) => annotationCommand<AnnotationEntity>("save", { note }),
  bind: (noteKey: string, binding: BindingInput, replace?: AnnotationBinding) =>
    annotationCommand<AnnotationEntity>("bind", {
      noteKey,
      binding,
      replaceId: replace?.id,
      replaceVersion: replace?.version,
    }),
  style: (noteKey: string, binding: AnnotationBinding, style: string) =>
    annotationCommand<AnnotationEntity>("style", {
      noteKey,
      bindingId: binding.id,
      version: binding.version,
      style,
    }),
  unlink: (noteKey: string, binding: AnnotationBinding) =>
    annotationCommand<AnnotationEntity>("unbind", {
      noteKey,
      kind: binding.kind,
      bindingId: binding.id,
      version: binding.version,
    }),
  unlinkAll: (note: AnnotationEntity) =>
    annotationCommand<AnnotationEntity>("unbind-all", {
      noteKey: note.key,
      versions: Object.fromEntries(
        note.bindings
          .filter((b) => b.status !== "unbound")
          .map((b) => [b.id, b.version])
      ),
    }),
  undo: (noteKey: string, binding: AnnotationBinding, sourceTicket?: string) =>
    annotationCommand<AnnotationEntity>("undo", {
      noteKey,
      kind: binding.kind,
      bindingId: binding.id,
      version: binding.version,
      sourceTicket,
    }),
  delete: (note: Pick<AnnotationEntity, "key" | "version">) =>
    annotationCommand("delete", { key: note.key, version: note.version }),
  reading: (data: Record<string, unknown>, context: DatabaseReadContext = {}) =>
    annotationCommand<
      Array<{
        key: string;
        entityKey: string;
        bindingId: string;
        color: string;
        hasNote: boolean;
        notes: string;
        range: string;
        cfi: string;
        chapterIndex: number;
        txtAnchor?: { start: number; end: number };
      }>
    >("reading", data, context),
  export: () => annotationCommand("export"),
  import: (backup: unknown) => annotationCommand("import", { backup }),
  importDatabase: (buffer: ArrayBuffer) =>
    annotationCommand("import-database", { buffer: new Uint8Array(buffer) }),
};
// Legacy UI/export adapters derive one display location from bindings. These
// fields are never stored on the entity or sent through the old cloud contract.
export const listAnnotationPages = async (
  filter: Record<string, unknown> = {},
  details = false
) => {
  const result: AnnotationEntity[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await AnnotationService.list({
      ...filter,
      offset,
      limit: 200,
    });
    if (details) {
      for (const row of page.records) {
        const note = await AnnotationService.get(row.key);
        if (note) result.push(note);
      }
    } else result.push(...page.records);
    if (!page.hasMore) break;
  }
  return result;
};
export const saveLegacyNote = async (record: Record<string, unknown>) => {
  if (record.kind === "drawing" || (!record.kind && record.notes === "annotation" && record.color === "annotation"))
    return annotationCommand("drawing-save", { note: record });
  return AnnotationService.save({
    key: record.key as string | undefined,
    version: record.version as number | undefined,
    bookKey: record.bookKey as string,
    kind: (record.kind || "small") as AnnotationKind,
    title: (record.title || "") as string,
    notes: (record.notes || "") as string,
    tag: (record.tag || []) as string[],
  });
};
