import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnnotationTag, AnnotationTagService } from "../../utils/storage/annotationService";
import "./quick.css";
interface Props { bookKey:string; value:AnnotationTag[]; onChange:(tags:AnnotationTag[])=>void; disabled?:boolean; }
export default function TagPicker({bookKey,value,onChange,disabled}:Props) {
  const {t}=useTranslation();
  const [open,setOpen]=useState(false),[scope,setScope]=useState<"global"|"book">("book"),[page,setPage]=useState(0),[rows,setRows]=useState<AnnotationTag[]>([]),[more,setMore]=useState(false),[name,setName]=useState(""),[error,setError]=useState(false),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{if(!open)return;let active=true;setBusy(true);setError(false);setRows([]);
    void AnnotationTagService.list({bookKey,scope,offset:page*50,limit:50}).then(result=>{if(active){setRows(result.records);setMore(result.hasMore);}}).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};
  },[open,bookKey,scope,page,revision]);
  const add=async()=>{if(!name.trim()||busy)return;setBusy(true);setError(false);try{const tag=await AnnotationTagService.create({bookKey,scope,name:name.trim()});if(!value.some(item=>item.id===tag.id))onChange([...value,tag]);setName("");setRevision(v=>v+1);}catch{setError(true);}finally{setBusy(false);}};
  return <div className="annotation-tags"><div className="annotation-tag-chips">{value.map(tag=><button key={tag.id} disabled={disabled} title={t(tag.scope==="book"?"Local tags":"Global tags")} onClick={()=>onChange(value.filter(item=>item.id!==tag.id))}>{tag.name}<small>{t(tag.scope==="book"?"Local":"Global")}</small> ×</button>)}<button disabled={disabled} aria-expanded={open} onClick={()=>setOpen(!open)}>＋ {t("Tags")}</button></div>
    {open&&<div className="annotation-tag-chooser"><div className="annotation-actions">{(["book","global"] as const).map(item=><button key={item} aria-pressed={scope===item} onClick={()=>{setScope(item);setPage(0);}}>{t(item==="book"?"Local tags":"Global tags")}</button>)}</div>
      {error&&<p role="alert">{t("Unable to load annotation")}</p>}<div className="annotation-tag-options" aria-busy={busy}>{rows.map(tag=><button key={tag.id} disabled={disabled||busy} aria-pressed={value.some(item=>item.id===tag.id)} onClick={()=>onChange(value.some(item=>item.id===tag.id)?value.filter(item=>item.id!==tag.id):[...value,tag])}>{tag.name}</button>)}</div>
      <div className="annotation-actions"><button disabled={busy||page===0} onClick={()=>setPage(page-1)}>{t("Previous")}</button><button disabled={busy||!more} onClick={()=>setPage(page+1)}>{t("Next")}</button><input aria-label={t("Tag name")} value={name} disabled={disabled} onChange={event=>setName(event.target.value)}/><button disabled={disabled||busy||!name.trim()} onClick={()=>void add()}>{t("Add")}</button></div>
    </div>}
  </div>;
}
