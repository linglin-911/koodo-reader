import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import copy from "copy-text-to-clipboard";
import { AnnotationService, AnnotationEntity, BindingInput } from "../../../utils/storage/annotationService";
import { captureAnnotation, notifyAnnotations, restoreAnnotations } from "../../../utils/reader/annotationUtil";
import { getIframeDoc } from "../../../utils/reader/docUtil";
import { useAppStore } from "../../../store/useAppStore";
import { ConfigService, HighlightUtil } from "../../../assets/lib/kookit-extra-browser.min";
import NoteTag from "../../noteTag";
import ColorOption from "../../colorOption";
import AnnotationEditor from "../../annotations/editor";
import type { PopupNoteProps } from "./component";
import "./popupNote.css";
const highlightUtil = new HighlightUtil(ConfigService);
interface Props extends PopupNoteProps {noteKey:string;bindingId:string;onClose:()=>void;}

// Keep the original selected-text editor shell. Advanced binding controls are
// opt-in; the default Confirm/Cancel/Delete/Copy flow remains the native one.
export default function NativeTextPopup(props:Props) {
  const {t}=useTranslation();
  const book=useAppStore(s=>s.book.currentBook),htmlBook=useAppStore(s=>s.reader.htmlBook),highlight=useAppStore(s=>s.reader.highlight);
  const [note,setNote]=useState<AnnotationEntity|null>(null),[body,setBody]=useState(""),[tag,setTag]=useState<string[]>([]),[quote,setQuote]=useState("");
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[managing,setManaging]=useState(false);
  const anchor=useRef<BindingInput|null>(null),pending=useRef(false),mounted=useRef(true),editor=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const binding=note?.bindings.find(b=>b.id===props.bindingId) || note?.bindings.find(b=>b.status!=="unbound");
  useEffect(()=>{
    let active=true;
    (async()=>{
      if(props.noteKey){
        const value=await AnnotationService.get(props.noteKey);
        if(!value)throw new Error("Annotation unavailable");
        if(!active)return;
        setNote(value);setBody(value.notes);setTag(value.tag);
        const selected=value.bindings.find(b=>b.id===props.bindingId)||value.bindings.find(b=>b.status!=="unbound");
        setQuote(selected?.quote || "");
        if(selected)useAppStore.getState().handleHighlight(highlightUtil.getHighlightValue(selected.style));
      }else if(htmlBook?.rendition){
        const text=getIframeDoc(book).map(doc=>doc?.getSelection()?.toString()||"").find(Boolean)||"";
        const position=await captureAnnotation(book,htmlBook.rendition,props.chapterDocIndex,props.chapter,highlightUtil.formatHighlightValue(highlight));
        if(!active)return;anchor.current=position;setQuote(text);
      }
      if(active){setLoading(false);editor.current?.focus();}
    })().catch(()=>{if(active){setLoading(false);toast.error(t(props.noteKey?"Unable to load annotation":"Select unchanged chapter body text"));}});
    return()=>{active=false;};
  },[props.noteKey,props.bindingId]);
  const run=async(action:()=>Promise<void>)=>{
    if(pending.current||loading)return;pending.current=true;setBusy(true);
    try{await action();notifyAnnotations();if(mounted.current)props.onClose();}
    catch{toast.error(t("Annotation changed or source unavailable; reload and retry"));}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const refresh=async()=>{
    if(htmlBook?.rendition&&(!note||note.bookKey===book.key)){
      // A saved entity must remain saved even if the reader is closed mid-refresh.
      try{await restoreAnnotations(book,htmlBook.rendition,props.chapterDocIndex);}catch{}
    }
  };
  const confirm=()=>run(async()=>{
    const style=highlightUtil.formatHighlightValue(highlight);
    if(note){
      let value=await AnnotationService.save({...note,notes:body,tag});setNote(value);
      if(binding&&binding.status!=="unbound"&&binding.style!==style){value=await AnnotationService.style(note.key,binding,style);setNote(value);}
    }else{
      if(!anchor.current)throw new Error("Source selection unavailable");
      await AnnotationService.create({bookKey:book.key,kind:"small",notes:body,tag},{...anchor.current,style});
    }
    await refresh();
  });
  const remove=()=>run(async()=>{if(note){await AnnotationService.delete(note);await refresh();toast.success(t("Deletion successful"));}});
  if(managing&&note)return <AnnotationEditor noteKey={note.key} bindingId={props.bindingId} onClose={()=>setManaging(false)} onSaved={()=>{void AnnotationService.get(note.key).then(value=>{if(value){setNote(value);setBody(value.notes);setTag(value.tag);}});}}/>;
  return <div className="note-editor" aria-busy={loading||busy}>
    <div className="note-original-text">{quote}</div>
    {note&&<button className="note-binding-management" onClick={()=>setManaging(true)}>{t("Manage bindings")}</button>}
    <div className="editor-box-parent"><textarea ref={editor} className="editor-box" aria-label={t("Annotation body")} style={{height:"calc(100% - 90px)"}}
      value={body} onChange={event=>setBody(event.target.value)} disabled={loading||busy}
      onKeyDown={event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)&&!event.nativeEvent.isComposing){event.preventDefault();void confirm();}}}/></div>
    <ColorOption isEdit={true} handleDigest={()=>{}}/>
    <div className="note-tags" style={{position:"absolute",bottom:"35px",height:"40px",width:"calc(100% - 40px)"}}>
      <NoteTag isEdit={true} isCard={false} tag={tag} handleTag={next=>setTag([...tag.filter(value=>!ConfigService.getAllListConfig("noteTags").includes(value)),...next])}/>
    </div>
    <div className="note-button-container">
      <span className="book-manage-title" role="button" tabIndex={0} onClick={()=>{copy(quote);toast.success(t("Copying successful"));}}>{t("Copy quotes")}</span>
      <span className="book-manage-title" role="button" tabIndex={0} onClick={()=>{if(note)void remove();else if(!busy)props.onClose();}}>{t(note?"Delete":"Cancel")}</span>
      <span className="book-manage-title" role="button" tabIndex={0} aria-disabled={loading||busy} onClick={()=>void confirm()}>{t("Confirm")}<span> (CTRL + ↵)</span></span>
    </div>
  </div>;
}
