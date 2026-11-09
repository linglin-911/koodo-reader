import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import { useAppStore } from "../../store/useAppStore";
import { captureAnnotation } from "../../utils/reader/annotationUtil";
import { AnnotationEntity, AnnotationService, BindingInput } from "../../utils/storage/annotationService";
import { getIframeDoc } from "../../utils/reader/docUtil";
import ReaderAnnotationPanel from "./readerPanel";
import QuickEditor from "./quickEditor";
import AnnotationReadOnly from "./readOnly";
import { ANNOTATION_HIT, QUICK_ANNOTATION, HitRequest, QuickRequest } from "./readerEvents";
import "./quick.css";
export default function ReaderAnnotationLayer() {
  const {t}=useTranslation(),book=useAppStore(s=>s.book.currentBook),htmlBook=useAppStore(s=>s.reader.htmlBook);
  const [query,setQuery]=useState(false);
  const [request,setRequest]=useState<QuickRequest|null>(null),[context,setContext]=useState<{binding:BindingInput;x:number;y:number}|null>(null),[hit,setHit]=useState<HitRequest|null>(null),[rows,setRows]=useState<AnnotationEntity[]>([]),[page,setPage]=useState(0),[more,setMore]=useState(false),[detail,setDetail]=useState("");
  const suppressHit=useRef(false);
  const float=useRef<HTMLDivElement>(null),contextRef=useRef<HTMLDivElement>(null),hitRef=useRef<HitRequest|null>(null);hitRef.current=hit;
  useLayoutEffect(()=>{const layout=request?.kind==="range"?"range":request?.kind==="chapter"?"chapter":query?"query":"none";useAppStore.setState(state=>({reader:{...state.reader,annotationLayout:layout}}));return()=>{useAppStore.setState(state=>({reader:{...state.reader,annotationLayout:"none"}}));};},[request?.kind,query]);
  useEffect(()=>{let active=true;
    const toggleQuery=()=>{setQuery(value=>!value);};
    const open=async(event:Event)=>{const next=(event as CustomEvent<QuickRequest>).detail;setContext(null);setHit(null);try{let binding=next.binding;if(next.selection)binding=await captureAnnotation(book,htmlBook.rendition,Number(htmlBook.rendition.getPosition()?.chapterDocIndex||0),"","underline-#888888");if(active){const store=useAppStore.getState();store.handleOpenMenu(false);store.handleMenuMode("");setRequest({...next,binding});}}catch{toast.error(t("Select unchanged chapter body text"));}};
    const target=(event:Event)=>{if(suppressHit.current){suppressHit.current=false;return;}if(hitRef.current){setHit(null);return;}setContext(null);setPage(0);setDetail("");setHit((event as CustomEvent<HitRequest>).detail);};
    const menu=(event:Event)=>{setHit(null);setContext((event as CustomEvent<{binding:BindingInput;x:number;y:number}>).detail);};
    window.addEventListener("koodo:annotation-query",toggleQuery);window.addEventListener(QUICK_ANNOTATION,open);window.addEventListener(ANNOTATION_HIT,target);window.addEventListener("koodo:chapter-context",menu);
    return()=>{active=false;window.removeEventListener("koodo:annotation-query",toggleQuery);window.removeEventListener(QUICK_ANNOTATION,open);window.removeEventListener(ANNOTATION_HIT,target);window.removeEventListener("koodo:chapter-context",menu);};
  },[book,htmlBook,t]);
  useEffect(()=>{if(!hit)return;let active=true;setRows([]);setMore(false);void AnnotationService.overlap({bookKey:book.key,bindingId:hit.bindingId,sourceTicket:htmlBook?.rendition?.txtIndexStore?.sourceTicket,offset:page*50,limit:50}).then(result=>{if(active){setRows(result.records);setMore(result.hasMore);}}).catch(()=>{if(active)toast.error(t("Unable to load annotation"));});return()=>{active=false;};},[hit,page,book.key,htmlBook,t]);
  useEffect(()=>{if(!hit&&!context)return;const outside=(event:Event)=>{if(float.current?.contains(event.target as Node)||contextRef.current?.contains(event.target as Node))return;if(hitRef.current)suppressHit.current=true;setHit(null);setContext(null);};const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){setHit(null);setContext(null);}};const clear=()=>{setTimeout(()=>{suppressHit.current=false;},0);};const docs=[document,...getIframeDoc(book).filter((doc):doc is Document=>!!doc)];for(const doc of docs){doc.addEventListener("pointerdown",outside,true);doc.addEventListener("click",clear);doc.addEventListener("keydown",key,true);}return()=>{for(const doc of docs){doc.removeEventListener("pointerdown",outside,true);doc.removeEventListener("click",clear);doc.removeEventListener("keydown",key,true);}};},[hit,context,book]);
  return <>{query&&!request&&<ReaderAnnotationPanel onClose={()=>setQuery(false)}/>}
    {context&&<div ref={contextRef} className="annotation-context-menu" role="menu" style={{left:Math.max(8,Math.min(context.x,window.innerWidth-230)),top:Math.max(8,Math.min(context.y,window.innerHeight-100))}}>{(["chapter","range"] as const).map(kind=><button role="menuitem" key={kind} onClick={()=>{setRequest({kind,binding:context.binding});setContext(null);}}>{t(kind==="chapter"?"New chapter annotation":"New range annotation")}</button>)}</div>}
    {request&&<QuickEditor key={request.noteKey||`${request.kind}:${request.binding?.chapterId}:${request.append}`} request={request} onClose={()=>setRequest(null)}/>}
    {hit&&<div ref={float} className="annotation-floating" role="dialog" aria-label={t("Annotations")} style={{left:Math.max(8,Math.min(hit.x,window.innerWidth-420)),top:Math.max(8,Math.min(hit.y+12,window.innerHeight-360))}}><header><strong>{t("Annotations")}</strong><button onClick={()=>setHit(null)}>{t("Close")}</button></header>{detail?<AnnotationReadOnly noteKey={detail} onClose={()=>setDetail("")}/>:<>{rows.map(row=><button className="annotation-hit-row" key={row.key} onClick={()=>setDetail(row.key)}><blockquote>{row.text}</blockquote><span>{row.notes}</span><small>{row.tag.join(" · ")}</small></button>)}<div className="annotation-actions"><button disabled={!page} onClick={()=>setPage(page-1)}>{t("Previous")}</button><button disabled={!more} onClick={()=>setPage(page+1)}>{t("Next")}</button></div></>}</div>}
  </>;
}
