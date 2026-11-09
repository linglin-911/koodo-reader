import {useEffect,useState} from "react";
import {useTranslation} from "react-i18next";
import {AnnotationEntity,AnnotationKind,AnnotationService,AnnotationBinding} from "../../utils/storage/annotationService";
import {useAppStore} from "../../store/useAppStore";
import ChapterPreview from "./chapterPreview";
import ManagerDetail from "./managerDetail";
import "./annotations.css";
import "./quick.css";
const labels={small:"Small annotation",chapter:"Chapter annotation",range:"Range annotation",tags:"Local tags"};
export default function AnnotationWorkspace(){
 const {t}=useTranslation(),books=useAppStore(s=>s.manager.books)||[],currentBook=useAppStore(s=>s.book.currentBook);
 const [bookKey,setBookKey]=useState(currentBook?.key||books[0]?.key||""),[kind,setKind]=useState<AnnotationKind|"tags">("small"),[rows,setRows]=useState<AnnotationEntity[]>([]),[selected,setSelected]=useState(""),[creating,setCreating]=useState(false),[page,setPage]=useState(0),[more,setMore]=useState(false),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const [previewBinding,setPreviewBinding]=useState<AnnotationBinding|null>(null);
 useEffect(()=>setPreviewBinding(null),[bookKey,kind]);
 const book=books.find(item=>item.key===bookKey);
 useEffect(()=>{if(!bookKey&&books[0])setBookKey(books[0].key);},[bookKey,books]);
 useEffect(()=>{let active=true;setRows([]);setError(false);if(!book||kind==="tags")return;setBusy(true);void AnnotationService.list({bookKey,kind,offset:page*50,limit:50}).then(result=>{if(active){setRows(result.records);setMore(result.hasMore);}}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[bookKey,kind,page,revision]);

 return <main className="annotation-management"><aside className="annotation-management-nav"><label>{t("Book")}<select aria-label={t("Book")} value={bookKey} onChange={event=>{setBookKey(event.target.value);setSelected("");setCreating(false);setPage(0);}}>{books.map(item=><option key={item.key} value={item.key}>{item.name}</option>)}</select></label><nav>{Object.entries(labels).map(([value,label])=><button key={value} aria-pressed={kind===value} onClick={()=>{setKind(value as AnnotationKind|"tags");setSelected("");setCreating(false);setPage(0);}}>{t(label)}</button>)}</nav></aside>
 {kind==="tags"?<section className="annotation-management-tags"><h2>{t("Local tags")}</h2></section>:<><section className="annotation-management-list"><header><strong>{t(labels[kind])}</strong><button disabled={!book} onClick={()=>{setSelected("");setCreating(true);}}>{t("New")}</button></header>{error&&<p role="alert">{t("Unable to load annotation")}</p>}<div className="annotation-management-rows" aria-busy={busy}>{rows.map(row=><button key={row.key} aria-pressed={selected===row.key} onClick={()=>{setSelected(row.key);setCreating(false);}}><span>{row.notes||t("Unbound annotation")}</span><small>{row.tag.join(" · ")}</small><small>{row.bindingCount?`${row.chapterLabels?.join(" · ")||row.chapter} · ${row.bindingCount}`:t("Unbound annotation")}</small></button>)}</div><footer><button disabled={busy||!page} onClick={()=>setPage(page-1)}>{t("Previous")}</button><button disabled={busy||!more} onClick={()=>setPage(page+1)}>{t("Next")}</button></footer></section>{book&&<ManagerDetail key={`${bookKey}:${kind}:${selected}:${creating}`} book={book} noteKey={selected||undefined} kind={kind} creating={creating} revision={revision} onPreview={book.format==="TXT"?setPreviewBinding:undefined} onSaved={key=>{setSelected(key||"");setCreating(false);setRevision(value=>value+1);}}/>}</>}
 {book&&previewBinding&&<ChapterPreview book={book} binding={previewBinding} onClose={()=>setPreviewBinding(null)}/>}
 </main>;
}
