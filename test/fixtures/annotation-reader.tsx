import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import * as Kookit from "/src/assets/lib/kookit.min.js";
import { openPersistentTxt } from "/src/utils/storage/txtIndexService.ts";
import { AnnotationService } from "/src/utils/storage/annotationService.ts";
import { restoreAnnotations } from "/src/utils/reader/annotationUtil.ts";
import { useAppStore } from "/src/store/useAppStore.ts";
import PopupNote from "/src/components/popups/popupNote/component.tsx";
import PopupBox from "/src/components/popups/popupBox/component.tsx";
import AnnotationEditor from "/src/components/annotations/editor.tsx";
import NoteList from "/src/containers/lists/noteList/component.tsx";
import {MemoryRouter} from "react-router-dom";
import AnnotationWorkspace from "/src/components/annotations/workspace.tsx";
import PopupOption from "/src/components/popups/popupOption/component.tsx";
import { getParserRegex } from "/src/utils/common.ts";
import i18n from "/src/i18n.tsx";
export async function run() {
    await i18n.changeLanguage("en");
    const assert = (value: unknown, message: string) => { if (!value)
        throw new Error(message); };
    let cases = 0;
    const wait = async (check: () => boolean | Promise<boolean>, message: string) => { const until = Date.now() + 10000; while (Date.now() < until) {
        if (await check())
            return;
        await new Promise(resolve => setTimeout(resolve, 20));
    } throw new Error(message); };
    const area = document.getElementById("page-area")!, host = document.getElementById("editor")!, root = createRoot(host);
    const parserRegex = getParserRegex("TXT", "fixture");
    const render=(node:React.ReactNode)=>flushSync(()=>root.render(<React.StrictMode>{node}</React.StrictMode>));
    const opened = await openPersistentTxt("fixture", "", "utf-8", parserRegex);
    const rendition = Kookit.BookHelper.getRendition(opened.buffer, { format: "TXT", charset: opened.encoding, parserRegex, txtIndexStore: opened.store, readerMode: "scroll", animation: "none", isMobile: "no", platform: "electron" }, Kookit);
    const book = { ...useAppStore.getState().book.currentBook, key: "fixture", name: "Synthetic annotation fixture", format: "TXT", charset: "utf-8", path: "", description: "" };
    useAppStore.setState(state => ({ manager: { ...state.manager, books: [book] }, book: { ...state.book, currentBook: book, isReading:true }, reader: { ...state.reader, htmlBook: { ...state.reader.htmlBook, rendition } } }));
    await rendition.renderTo(area);
    await rendition.goToChapterDocIndex(0);
    const select = (start: number, end: number) => {
        const doc = rendition.getDocument()!, paragraph = doc.querySelector<HTMLElement>('p[data-txt-start]')!;
        const nodes: Text[] = [], walker = doc.createTreeWalker(paragraph, 4, { acceptNode: node => node.parentElement?.closest(".kookit-note-icon,.kookit-note-tooltip") ? 2 : 1 });
        while (walker.nextNode())
            nodes.push(walker.currentNode as Text);
        const point = (offset: number) => { for (const node of nodes) {
            if (offset <= node.length)
                return { node, offset };
            offset -= node.length;
        } throw new Error("Selection point missing"); };
        const a = point(start), b = point(end), range = doc.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        const selection = doc.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
    };
    const set = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    };
    const button = (text: string) => Array.from(host.querySelectorAll<HTMLElement>("button,[role=button]")).find(button => button.textContent?.trim() === text || (text==="Confirm"&&button.textContent?.trim().startsWith("Confirm (")))!;
    const body = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Annotation body"]');
    assert(rendition.getDocument()!.body.textContent!.includes("正文一😀 & <tag>"), "TXT metacharacters were interpreted as markup");
    select(0, 5);
    const a = rendition.getAnnotationAnchor();
    assert(a.start === 0 && a.end === 5, "Source UTF-16 mapping mismatch");
    await AnnotationService.list();
    // Original selection -> menu -> native shell. A failed write keeps the
    // draft and creates no entity; retry and keyboard confirmation create once.
    useAppStore.getState().handleAnnotationTarget("");
    render(<PopupOption noteKey="" rect={new DOMRect()} cfiRange="" chapterDocIndex={0} chapter="Chapter 1"/>);
    await wait(()=>!!host.querySelector('[data-tooltip-content="Small annotation"]'),"Original note menu action missing");
    (host.querySelector('[data-tooltip-content="Small annotation"]') as HTMLElement).click();
    render(<PopupNote isDockedRight={false} chapterDocIndex={0} chapter="Chapter 1"/>);
    await wait(()=>!!body()&&!body()!.disabled,"Original selection editor unavailable");
    assert(!!host.querySelector(".note-editor .note-original-text")&&!button("Copy quotes")&&!button("Cancel")&&!!button("Confirm")&&!host.querySelector(".color-option-container"),"Simplified editor actions mismatch");
    await window.electronAPI.invoke("annotation-test-preview","native");
    set(body()!,"retryable atomic draft");
    await window.electronAPI.invoke("annotation-test-fail-create",true);button("Confirm").click();
    await wait(async()=> (await window.electronAPI.invoke("annotation-test-diagnostics")).main.some((entry:{failed:boolean})=>entry.failed),"Failure was not reported by the native transaction");
    await wait(()=>!body()!.disabled,"Editor did not recover from failed transaction");
    assert((await AnnotationService.list({keyword:"retryable atomic draft"})).records.length===0,"Failed initial binding left an orphan entity");
    assert(body()!.value==="retryable atomic draft","Failed save lost the editor draft");cases++;
    await window.electronAPI.invoke("annotation-test-fail-create",false);
    body()!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true}));
    await wait(async()=> (await AnnotationService.list({keyword:"retryable atomic draft"})).records.length===1,"Ctrl+Enter retry failed");
    const created=(await AnnotationService.list({keyword:"retryable atomic draft"})).records[0];
    assert((await AnnotationService.get(created.key))!.bindings.length===1,"Retry did not create exactly one binding");
    await wait(()=>!useAppStore.getState().viewArea.isOpenMenu,"Confirmation no longer closes original popup");cases++;
    useAppStore.getState().handleAnnotationTarget(created.key);
    useAppStore.getState().handleMenuMode("note");useAppStore.getState().handleOpenMenu(true);
    render(<PopupBox key="close-existing" rendition={rendition} rect={new DOMRect()} chapterDocIndex={0} chapter="Chapter 1"/>);
    await wait(()=>body()?.value==="retryable atomic draft","Reopening created entity failed");
    host.querySelector<HTMLButtonElement>(".small-annotation-close")!.click();
    assert(!!(await AnnotationService.get(created.key)),"Closing the small-annotation popup deleted its entity");
    await AnnotationService.delete((await AnnotationService.get(created.key))!);cases++;
    select(0,5);useAppStore.getState().handleAnnotationTarget("");
    useAppStore.getState().handleMenuMode("note");useAppStore.getState().handleOpenMenu(true);
    render(<PopupBox key="close-new" rendition={rendition} rect={new DOMRect()} chapterDocIndex={0} chapter="Chapter 1"/>);
    await wait(()=>!!body()&&!body()!.disabled&&!!host.querySelector(".small-annotation-close"),"Small annotation close action missing");
    set(body()!,"cancelled draft");host.querySelector<HTMLButtonElement>(".small-annotation-close")!.click();
    assert((await AnnotationService.list({keyword:"cancelled draft"})).records.length===0,"Closing draft wrote an entity");cases++;
    select(0,5);
    let small = await AnnotationService.save({ bookKey: book.key, kind: "small", title: "Small entity", notes: "small body", tag: ["small"] });
    small = await AnnotationService.bind(small.key, a);
    select(2, 8);
    small = await AnnotationService.bind(small.key, { ...rendition.getAnnotationAnchor(), style: "underline-#FF0000" });
    await restoreAnnotations(book, rendition, 0);
    let doc = rendition.getDocument()!;
    assert(new Set(Array.from(doc.querySelectorAll<HTMLElement>("[data-binding-id]")).map(el => el.dataset.bindingId)).size === 2, "Overlapping bindings were collapsed");
    for (const binding of small.bindings) {
        const text = Array.from(doc.querySelectorAll<HTMLElement>(`.kookit-note[data-key="${binding.id}"]`)).map(el => el.textContent).join("");
        assert(text === binding.quote, "Overlapping highlight source range drifted");
    }
    assert(doc.querySelector('p[data-txt-start]')!.textContent === "正文一😀 & <tag>", "Highlight wrappers changed source text");
    cases++;
    const clicked = doc.querySelector<HTMLElement>(`[data-binding-id="${small.bindings[1].id}"]`)!;
    clicked.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    assert(useAppStore.getState().reader.noteKey === small.key && useAppStore.getState().reader.noteBindingId === small.bindings[1].id, "Highlight click lost entity/binding identity");
    cases++;
    render(<PopupNote isDockedRight={false} chapterDocIndex={0} chapter="Chapter 1"/>);
    await wait(() => !!body() && body()!.value === "small body", "Original note popup did not load entity body");
    const beforeBodyEdit = small.bindings.map(binding=>({id:binding.id,style:binding.style,version:binding.version}));
    set(body()!, "annotation"); button("Confirm").click();
    await wait(async()=> (await AnnotationService.get(small.key))?.notes==="annotation","Literal drawing sentinel text was not saved");
    await wait(()=>useAppStore.getState().reader.noteKey==="","Original edit did not finish closing");
    useAppStore.getState().handleAnnotationTarget(small.key,small.bindings[1].id);
    render(<PopupNote key="literal-body" isDockedRight={false} chapterDocIndex={0} chapter="Chapter 1"/>);
    await wait(()=>body()?.value==="annotation","Formal text was mistaken for a drawing"); cases++;
    set(body()!, "edited in original popup");
    button("Confirm").click();
    await wait(async () => (await AnnotationService.get(small.key))?.notes === "edited in original popup", "Original note popup failed to save body");
    await wait(()=>useAppStore.getState().reader.noteKey==="","Second edit did not finish closing");
    small = (await AnnotationService.get(small.key))!;
    assert(small.bindings.length === 2, "Body editing rewrote positions");
    assert(JSON.stringify(small.bindings.map(binding=>({id:binding.id,style:binding.style,version:binding.version})))===JSON.stringify(beforeBodyEdit),"Body editing rewrote binding styles or versions");
    cases++;
    await rendition.goToChapterDocIndex(1);
    select(0, 5);
    // The menu no longer exposes append. Retain its existing data/editor
    // contract coverage directly, without adding another menu feature.
    render(<PopupOption noteKey="" rect={new DOMRect()} cfiRange="" chapterDocIndex={1} chapter="Chapter 2"/>);
    assert(!host.querySelector('[data-tooltip-content="Add to small annotation"]'),"Removed append entry reappeared");
    useAppStore.getState().handleAnnotationTarget("","",true);
    render(<PopupNote isDockedRight={false} chapterDocIndex={1} chapter="Chapter 2"/>);
    await wait(() => !!host.querySelector('select[aria-label="Choose existing annotation"] option[value="' + small.key + '"]'), "Existing annotation chooser did not load");
    set(host.querySelector<HTMLSelectElement>('select[aria-label="Choose existing annotation"]')!, small.key);
    await wait(() => !!button("Add location") && body()?.value === "edited in original popup", "Existing entity was not selected");
    button("Add location").click();
    await wait(async () => (await AnnotationService.get(small.key))?.bindings.length === 3, "Append replaced or failed to add a binding");
    cases++;
    const renderEditor = async (kind: "chapter" | "range", value: string) => {
        render(<AnnotationEditor key={kind} kind={kind} bookKey={book.key} onClose={() => { }}/>);
        await wait(() => !!body() && body()!.value === "", "New annotation editor missing");
        set(body()!, value);
        button("Save").click();
        await wait(async () => (await AnnotationService.list({ kind })).records.length === 1, "Unbound entity creation failed");
        await wait(() => !!button("Load chapters") && !button("Load chapters").disabled, "Editor remained busy after saving");
        button("Load chapters").click();
        await wait(() => !!host.querySelector('select[aria-label="Start chapter"]'), "Chapter chooser missing");
        const start = host.querySelector<HTMLSelectElement>('select[aria-label="Start chapter"]')!;
        set(start, "0");
        if (kind === "range")
            set(host.querySelector<HTMLSelectElement>('select[aria-label="End chapter"]')!, "2");
        button("Set binding").click();
        const key = (await AnnotationService.list({ kind })).records[0].key;
        await wait(async () => (await AnnotationService.get(key))!.bindings.some(b => b.status === "active"), "Chapter/range UI failed to bind");
        return key;
    };
    // PDF uses its own page locator. Removing the last relationship must
    // clear that page without requiring another note to trigger rendering.
    const pdf=Kookit.BookHelper.getRendition(new ArrayBuffer(0),{format:"PDF",readerMode:"scroll",platform:"electron"},Kookit);
    const pdfDoc=document.implementation.createHTMLDocument("synthetic PDF page");
    pdfDoc.body.innerHTML='<div class="kookit-note" data-key="removed"></div>';
    pdf.getSubDocument=()=>pdfDoc;pdf.getSubIframe=()=>document.createElement("iframe");
    await pdf.renderHighlighters([],()=>{},2);
    assert(!pdfDoc.querySelector(".kookit-note"),"Removing the final PDF binding left a stale highlight");cases++;
    const chapterKey = await renderEditor("chapter", "chapter body");
    cases++;
    const rangeKey = await renderEditor("range", "range body");
    cases++;
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.electronAPI.invoke("annotation-test-preview");
    button("Unbind all").click();
    await wait(async () => (await AnnotationService.get(rangeKey))!.bindings.every(b => b.status === "unbound"), "Range unlink failed");
    assert((await AnnotationService.get(rangeKey))!.notes === "range body", "Range unlink deleted body");
    await wait(() => !!button("Undo unbind"), "Undo action missing");
    button("Undo unbind").click();
    await wait(async () => (await AnnotationService.get(rangeKey))!.bindings.some(b => b.status === "active"), "Undo did not restore relationship");
    cases++;
    const scope = host.querySelector<HTMLSelectElement>('select[aria-label="Start chapter"]')!;
    set(scope, "1");
    button("Related annotations").click();
    await wait(() => host.textContent!.includes("Small entity"), "Related annotation lookup failed");
    cases++;
    render(<AnnotationWorkspace />);
    await wait(() => host.querySelectorAll(".annotation-entities li").length === 3, "Entity list duplicated multi-location notes or hid unbound entities");
    cases++;
    useAppStore.getState().handleMenuMode("");useAppStore.getState().handleNoteKey("");
    useAppStore.setState(state=>({sidebar:{...state.sidebar,mode:"note"}}));
    render(<MemoryRouter><NoteList/></MemoryRouter>);
    await wait(()=>!!host.querySelector(".note-list-container-parent .card-list-container"),"Original card list was replaced");
    assert(!host.querySelector(".annotation-workspace"),"Three-type workspace replaced the default native list");
    button("Annotations").click();await wait(()=>!!host.querySelector(".annotation-workspace"),"Separate annotation management entry missing");cases++;
    const evidence=await window.electronAPI.invoke("annotation-test-diagnostics");
    const trace=evidence.main.find((entry:{traceId?:string;statementCount:number})=>entry.traceId===rendition.diagnosticTraceId&&entry.statementCount>0);
    assert(!!trace&&evidence.renderer.some((entry:{requestId:string})=>entry.requestId===trace.requestId),"Actual reader/SQLite diagnostics lost request correlation");cases++;
    // A transformed line must be rejected instead of creating false original coordinates.
    await rendition.goToChapterDocIndex(0);
    doc = rendition.getDocument()!;
    doc.querySelector('p[data-txt-start]')!.textContent = "replaced text";
    select(0, 2);
    let rejected = false;
    try {
        rendition.getAnnotationAnchor();
    }
    catch {
        rejected = true;
    }
    assert(rejected, "Changed display text produced an invented source coordinate");
    cases++;
    assert((await AnnotationService.get(chapterKey))!.notes === "chapter body", "Other type changed another entity body");
    return { passed: true, cases, strictMode:true, normalCompiledEngine: true, originalSelectionMenuAndPopup: true, userDatabaseOpened: false, smallKey: small.key };
}
