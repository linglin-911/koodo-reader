import BindingList from "./bindingList";
import {useEffect,useState} from "react";
import {useTranslation} from "react-i18next";
import toast from "react-hot-toast";
import {useAppStore} from "../../store/useAppStore";
import {AnnotationBinding,AnnotationEntity,AnnotationKind,AnnotationService} from "../../utils/storage/annotationService";
import {openQuickAnnotation} from "./readerEvents";
import {jumpToBinding} from "./readerNavigation";
import "./quick.css";
interface Props {onClose:()=>void;}
const labels={small:"Small annotation",chapter:"Chapter annotation",range:"Range annotation"};
export default function ReaderAnnotationPanel({onClose}:Props){
 const {t}=useTranslation(),book=useAppStore(s=>s.book.currentBook),rendition=useAppStore(s=>s.reader.htmlBook)?.rendition,index=useAppStore(s=>s.reader.currentChapterIndex),notes=useAppStore(s=>s.reader.notes);
 const [kind,setKind]=useState<AnnotationKind>("small"),[page,setPage]=useState(0),[rows,setRows]=useState<AnnotationEntity[]>([]),[more,setMore]=useState(false),[selected,setSelected]=useState(""),[note,setNote]=useState<AnnotationEntity|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;setBusy(true);setRows([]);setError(false);const chapter=rendition?.book?.sections?.[index]?.chapter;
  if(book.format!=="TXT"||!chapter){setBusy(false);return;}
  void AnnotationService.list({bookKey:book.key,kind,chapterIndex:index,chapterId:chapter.chapterId,sourceTicket:rendition?.txtIndexStore?.sourceTicket,offset:page*50,limit:50}).then(result=>{if(active){setRows(result.records);setMore(result.hasMore);}}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};
 },[book.key,book.format,rendition,index,kind,page,notes]);
 useEffect(()=>{let active=true;setNote(null);if(selected)void AnnotationService.get(selected).then(value=>{if(active)setNote(value);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[selected,notes]);
 useEffect(()=>setPage(0),[index]);
 const jump=async(binding:AnnotationBinding)=>{try{await jumpToBinding(binding);}catch{toast.error(t("Annotation changed or source unavailable; reload and retry"));}};
 return <aside className="reader-annotation-panel" aria-label={t("Current chapter annotations")}><header><strong>{t("Current chapter annotations")}</strong><button onClick={onClose}>{t("Close")}</button></header><nav>{(Object.entries(labels) as Array<[AnnotationKind,string]>).map(([value,label])=><button key={value} aria-pressed={kind===value} onClick={()=>{setKind(value);setPage(0);setSelected("");}}>{t(label)}</button>)}</nav>
 {error&&<p role="alert">{t("Unable to load annotation")}</p>}
 {note?<section className="reader-annotation-detail"><header><button onClick={()=>setSelected("")}>{t("Back")}</button>{note.kind!=="small"&&<button aria-label={t("Edit")} onClick={()=>openQuickAnnotation({kind:note.kind,noteKey:note.key})}>✎</button>}</header><p className="annotation-meta">{note.tagRefs.map(tag=>tag.name).join(" · ")}</p><div className="annotation-body">{note.notes}</div><div className="reader-binding-list"><BindingList bindings={note.bindings} onSelect={note.kind==="range"?undefined:binding=>void jump(binding)}/></div></section>:<><div className="reader-annotation-list" aria-busy={busy}>{rows.map(row=><button key={row.key} onClick={()=>setSelected(row.key)}><span>{row.notes||t("Unbound annotation")}</span><small>{row.tag.join(" · ")}</small></button>)}{!busy&&!rows.length&&!error&&<p>{t("No annotations in this chapter")}</p>}</div><footer><button disabled={busy||!page} onClick={()=>setPage(page-1)}>{t("Previous")}</button><button disabled={busy||!more} onClick={()=>setPage(page+1)}>{t("Next")}</button></footer></>}
 </aside>;
}
