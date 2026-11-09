import {useEffect,useRef,useState} from "react";
import {useTranslation} from "react-i18next";
import type Book from "../../models/Book";
import type {AnnotationBinding} from "../../utils/storage/annotationService";
import {createSingleChapterPreview} from "./sourcePreview";
interface Props {book:Book;binding:AnnotationBinding;onClose:()=>void;}
export default function ChapterPreview({book,binding,onClose}:Props){
 const {t}=useTranslation(),area=useRef<HTMLDivElement>(null),[loading,setLoading]=useState(true),[error,setError]=useState(false);
 useEffect(()=>{const controller=new AbortController();let preview:Awaited<ReturnType<typeof createSingleChapterPreview>>|undefined;const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose();};document.addEventListener("keydown",escape);
  void createSingleChapterPreview(book,binding,area.current!,controller.signal).then(value=>{if(controller.signal.aborted){void value.destroy();return;}preview=value;value.doc.addEventListener("keydown",escape);setLoading(false);}).catch(()=>{if(!controller.signal.aborted){setError(true);setLoading(false);}});
  return()=>{controller.abort();document.removeEventListener("keydown",escape);preview?.doc.removeEventListener("keydown",escape);void preview?.destroy();};
 },[book.key,binding.id]);
 return <div className="annotation-modal-scrim"><section className="annotation-preview-dialog" role="dialog" aria-modal="true" aria-label={t("Source preview")}><header><strong>{binding.anchor.chapter?.label||t("Preamble")}</strong><button onClick={onClose}>{t("Close")}</button></header>{error&&<p role="alert">{t("Annotation changed or source unavailable; reload and retry")}</p>}<div ref={area} className="annotation-preview-area" aria-busy={loading}/></section></div>;
}
