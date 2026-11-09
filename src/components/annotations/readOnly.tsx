import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnnotationEntity, AnnotationService } from "../../utils/storage/annotationService";
interface Props { noteKey:string; onClose?:()=>void; }
export default function AnnotationReadOnly({noteKey,onClose}:Props) {
  const {t}=useTranslation(),[note,setNote]=useState<AnnotationEntity|null>(null),[error,setError]=useState(false);
  useEffect(()=>{let active=true;setNote(null);setError(false);void AnnotationService.get(noteKey).then(value=>{if(active){setNote(value);setError(!value);}}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[noteKey]);
  return <article className="annotation-readonly" aria-busy={!note&&!error}>{onClose&&<button onClick={onClose}>{t("Close")}</button>}{error&&<p role="alert">{t("Unable to load annotation")}</p>}{note&&<><p className="annotation-meta">{note.tagRefs.map(tag=>tag.name).join(" · ")}</p><div className="annotation-body">{note.notes}</div></>}</article>;
}
