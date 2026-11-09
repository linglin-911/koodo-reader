import {useEffect,useRef,useState} from "react";
import {useTranslation} from "react-i18next";
import {AnnotationBinding,AnnotationEntity,AnnotationKind,AnnotationService,AnnotationTag} from "../../utils/storage/annotationService";
import {notifyAnnotations} from "../../utils/reader/annotationUtil";
import type Book from "../../models/Book";
import TagPicker from "./tagPicker";
import BindingManager from "./bindingManager";
import BindingList from "./bindingList";
interface Props {book:Book;noteKey?:string;kind:AnnotationKind;creating?:boolean;revision:number;onSaved:(key?:string)=>void;onPreview?:(binding:AnnotationBinding)=>void;}
export default function ManagerDetail({book,noteKey,kind,creating,revision,onSaved,onPreview}:Props){
 const {t}=useTranslation(),[note,setNote]=useState<AnnotationEntity|null>(null),[editing,setEditing]=useState(!!creating),[body,setBody]=useState(""),[tags,setTags]=useState<AnnotationTag[]>([]),[tagDialog,setTagDialog]=useState(false),[bindings,setBindings]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),pending=useRef(false);
 useEffect(()=>{let active=true;setNote(null);setEditing(!!creating);setBody("");setTags([]);setError(false);if(noteKey)void AnnotationService.get(noteKey).then(value=>{if(active){setNote(value);setBody(value?.notes||"");setTags(value?.tagRefs||[]);setError(!value);}}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[noteKey,revision,creating,book.key]);
 const save=async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError(false);try{const value=await AnnotationService.save({key:note?.key,version:note?.version,bookKey:book.key,kind,notes:body,tagIds:tags.map(tag=>tag.id)});setNote(value);setEditing(false);notifyAnnotations();onSaved(value.key);}catch{setError(true);}finally{pending.current=false;setBusy(false);}};
 const remove=async()=>{if(!note||busy||!window.confirm(t("Delete annotation?")))return;setBusy(true);try{await AnnotationService.delete(note);notifyAnnotations();onSaved();}catch{setError(true);}finally{setBusy(false);}};
 if(!note&&!creating)return <section className="annotation-manager-detail">{error&&<p role="alert">{t("Unable to load annotation")}</p>}</section>;
 const active=note?.bindings.filter(binding=>binding.status!=="unbound")||[];
 const chapter=active[0]?.anchor.chapter||active[0]?.anchor.start;
 return <section className={`annotation-manager-detail detail-${kind}`} aria-label={t("Annotation details")}><div className="annotation-detail-upper"><header><strong>{t(kind==="small"?"Small annotation":kind==="chapter"?"Chapter annotation":"Range annotation")}</strong>{!editing&&<button aria-label={t("Edit")} onClick={()=>setEditing(true)}>✎</button>}</header>
 {kind!=="small"&&<div className="annotation-meta">{chapter?.label||t("Unbound annotation")}{kind==="range"&&active.length?` → ${active[0].anchor.end?.label||t("Preamble")}`:""}</div>}
 <div className="annotation-meta">{(editing?tags:note?.tagRefs||[]).map(tag=><span key={tag.id}>{tag.name} · </span>)}{editing&&<button onClick={()=>setTagDialog(true)}>{t("Tags")}</button>}</div>
 {error&&<p role="alert">{t("Annotation changed or source unavailable; reload and retry")}</p>}
 {editing?<textarea aria-label={t("Annotation body")} value={body} onChange={event=>setBody(event.target.value)} disabled={busy}/>:<div className="annotation-body">{note?.notes}</div>}
 {editing?<footer><button disabled={busy} onClick={()=>{setBody(note?.notes||"");setTags(note?.tagRefs||[]);setEditing(false);}}>{t("Cancel")}</button><button disabled={busy} onClick={()=>void save()}>{t("Save")}</button></footer>:<footer><button onClick={()=>setBindings(true)}>{t("Manage bindings")}</button><button disabled={busy} onClick={()=>void remove()}>{t("Delete annotation")}</button></footer>}
 </div>{kind==="small"&&<BindingList bindings={note?.bindings||[]} onSelect={onPreview}/>}{kind==="chapter"&&active.map(binding=><button className="annotation-chapter-preview" key={binding.id} disabled={!onPreview||binding.status!=="active"} onClick={()=>onPreview?.(binding)}>{chapter?.label||t("Preamble")}</button>)}
 {tagDialog&&<div className="annotation-modal-scrim"><section className="annotation-tag-dialog" role="dialog" aria-modal="true" aria-label={t("Tags")}><header><strong>{t("Tags")}</strong><button onClick={()=>setTagDialog(false)}>{t("Close")}</button></header><TagPicker bookKey={book.key} value={tags} onChange={setTags}/></section></div>}
 {bindings&&note&&<BindingManager note={note} book={book} onChange={value=>{setNote(value);notifyAnnotations();onSaved(value.key);}} onClose={()=>setBindings(false)}/>}
 </section>;
}
