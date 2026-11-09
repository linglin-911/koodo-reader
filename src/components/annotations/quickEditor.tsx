import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { AnnotationEntity, AnnotationService, AnnotationTag, BindingInput } from "../../utils/storage/annotationService";
import { notifyAnnotations } from "../../utils/reader/annotationUtil";
import { useAppStore } from "../../store/useAppStore";
import TagPicker from "./tagPicker";
import ChapterPicker, { ChapterChoice } from "./chapterPicker";
import AnnotationReadOnly from "./readOnly";
import type { QuickRequest } from "./readerEvents";
import "./quick.css";
interface Props { request:QuickRequest; onClose:()=>void; }
const names={small:"Small annotation",chapter:"Chapter annotation",range:"Range annotation"};
export default function QuickEditor({request,onClose}:Props) {
  const {t}=useTranslation(),book=useAppStore(s=>s.book.currentBook),rendition=useAppStore(s=>s.reader.htmlBook)?.rendition;
  const [note,setNote]=useState<AnnotationEntity|null>(null),[body,setBody]=useState(""),[tags,setTags]=useState<AnnotationTag[]>([]),[binding,setBinding]=useState<BindingInput|undefined>(request.binding),[chapters,setChapters]=useState<ChapterChoice[]>([]),[busy,setBusy]=useState(false),[loading,setLoading]=useState(!!request.noteKey),[error,setError]=useState(false);
  const [rows,setRows]=useState<AnnotationEntity[]>([]),[page,setPage]=useState(0),[more,setMore]=useState(false),[detail,setDetail]=useState(""),[selected,setSelected]=useState("");
  const pending=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{let active=true;if(request.kind!=="small")void rendition?.txtIndexStore?.readDirectory().then((directory:{chapters:ChapterChoice[]})=>{if(active)setChapters(directory.chapters);}).catch(()=>{if(active)setError(true);});
    if(request.noteKey)void AnnotationService.get(request.noteKey).then(value=>{if(!active)return;if(!value)throw Error("Missing annotation");setNote(value);setBody(value.notes);setTags(value.tagRefs);const b=value.bindings.find(item=>item.status!=="unbound");setBinding(b?{format:b.format,sourceTicket:rendition?.txtIndexStore?.sourceTicket,chapterIndex:b.start_index,chapterId:b.chapter_id||undefined,endChapterIndex:b.end_index,endChapterId:b.anchor.end?.chapterId}:undefined);setLoading(false);}).catch(()=>{if(active){setError(true);setLoading(false);}});return()=>{active=false;};
  },[request.noteKey]);
  useEffect(()=>{if(!request.append&&request.kind!=="range")return;let active=true;setRows([]);setMore(false);setDetail("");
    const filter=request.append?{bookKey:book.key,kind:"small"}:{bookKey:book.key,kinds:["small","chapter"],chapterIndex:binding?.chapterIndex,chapterId:binding?.chapterId,endChapterIndex:binding?.endChapterIndex??binding?.chapterIndex,endChapterId:binding?.endChapterId??binding?.chapterId,sourceTicket:binding?.sourceTicket};
    if(!request.append&&!binding)return;
    void AnnotationService.list({...filter,offset:page*50,limit:50}).then(result=>{if(active){setRows(result.records);setMore(result.hasMore);}}).catch(()=>{if(active)setError(true);});return()=>{active=false;};
  },[request.append,request.kind,binding,book.key,page]);
  const changeChapter=(index:number,end=false)=>{const chapter=chapters.find(item=>item.index===index);if(!chapter)return;setPage(0);setBinding(previous=>({...previous,format:"TXT",sourceTicket:rendition?.txtIndexStore?.sourceTicket,chapterIndex:previous?.chapterIndex??index,...(end?{endChapterIndex:index,endChapterId:chapter.chapterId}:{chapterIndex:index,chapterId:chapter.chapterId,...(request.kind==="chapter"||index>(previous?.endChapterIndex??index)?{endChapterIndex:index,endChapterId:chapter.chapterId}:{})})}));};
  const save=async()=>{if(pending.current||loading||error)return;if(!request.append&&request.kind==="small"&&!body.trim()){toast.error(t("Write an annotation before saving"));return;}pending.current=true;setBusy(true);
    try{if(request.append){if(!selected||!binding)throw Error("Missing selection");const target=await AnnotationService.get(selected);if(!target?.notes.trim())throw Error("Empty annotation");await AnnotationService.bind(selected,{...binding,sourceTicket:rendition?.txtIndexStore?.sourceTicket||binding.sourceTicket});}else{const data={bookKey:book.key,kind:request.kind,notes:body,tagIds:tags.map(tag=>tag.id)};
      if(note){const saved=await AnnotationService.save({...data,key:note.key,version:note.version});setNote(saved);const previous=note.bindings.find(item=>item.status!=="unbound");if(binding&&(!previous||previous.start_index!==binding.chapterIndex||previous.end_index!==(binding.endChapterIndex??binding.chapterIndex)))await AnnotationService.bind(saved.key,binding,previous);}
      else if(binding)await AnnotationService.create(data,{...binding,sourceTicket:rendition?.txtIndexStore?.sourceTicket||binding.sourceTicket});else await AnnotationService.save(data);
    }notifyAnnotations();if(mounted.current)onClose();}catch{toast.error(t("Annotation changed or source unavailable; reload and retry"));}finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const references=<section className="quick-references" aria-label={t(request.append?"Add to small annotation":"Related annotations")}><header><strong>{t(request.append?"Add to small annotation":"Related annotations")}</strong></header>{detail?<AnnotationReadOnly noteKey={detail} onClose={()=>setDetail("")}/>:<><div className="quick-reference-list">{rows.map(row=><button key={row.key} aria-pressed={selected===row.key} onClick={()=>request.append?setSelected(row.key):setDetail(row.key)}><span>{row.notes||t("Unbound annotation")}</span><small>{row.tag.join(" · ")}</small></button>)}</div><div className="annotation-actions"><button disabled={!page} onClick={()=>setPage(page-1)}>{t("Previous")}</button><button disabled={!more} onClick={()=>setPage(page+1)}>{t("Next")}</button></div></>}</section>;
  return <section className={`quick-annotation quick-${request.append?"append":request.kind}`} aria-label={t(names[request.kind])} aria-busy={busy||loading}>
    {(request.kind==="range"||request.append)&&references}<div className="quick-edit"><header><strong>{t(request.append?"Add to small annotation":names[request.kind])}</strong><button disabled={busy} onClick={onClose}>{t("Close")}</button></header>
    {error&&<p role="alert">{t("Unable to load annotation")}</p>}
    {request.kind==="small"&&binding&&<blockquote>{binding.quote||t("Selected source text")}</blockquote>}
    {request.kind!=="small"&&<div className="quick-chapters"><ChapterPicker chapters={chapters} value={binding?.chapterIndex??-1} onChange={index=>changeChapter(index)} label={request.kind==="chapter"?"Chapter binding":"Start chapter"} disabled={busy}/>{request.kind==="range"&&<ChapterPicker chapters={chapters} value={binding?.endChapterIndex??binding?.chapterIndex??-1} onChange={index=>changeChapter(index,true)} label="End chapter" disabled={busy}/>}</div>}
    {!request.append&&<><textarea autoFocus aria-label={t("Annotation body")} value={body} disabled={busy||loading} onChange={event=>setBody(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)&&!event.nativeEvent.isComposing){event.preventDefault();void save();}}}/><TagPicker bookKey={book.key} value={tags} onChange={setTags} disabled={busy||loading}/></>}
    <footer><button disabled={busy} onClick={onClose}>{t("Cancel")}</button><button disabled={busy||loading||error||(request.append&&!selected)||(!!binding&&request.kind==="range"&&(binding.endChapterIndex??binding.chapterIndex)<binding.chapterIndex)} onClick={()=>void save()}>{t(request.append?"Add location":"Save")}</button></footer></div>
  </section>;
}
