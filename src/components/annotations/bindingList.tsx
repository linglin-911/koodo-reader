import {useEffect,useMemo,useState} from "react";
import {useTranslation} from "react-i18next";
import {throttle} from "../../utils/common";
import type {AnnotationBinding} from "../../utils/storage/annotationService";
interface Props {bindings:AnnotationBinding[];onSelect?:(binding:AnnotationBinding)=>void;}
export default function BindingList({bindings,onSelect}:Props){
 const {t}=useTranslation(),[top,setTop]=useState(0),scroll=useMemo(()=>throttle((offset:number)=>setTop(offset),40),[]);
 useEffect(()=>()=>scroll.cancel(),[scroll]);
 const first=Math.max(0,Math.floor(top/108)-2);
 return <div className="annotation-binding-viewport" onScroll={event=>scroll(event.currentTarget.scrollTop)}><div style={{height:bindings.length*108,position:"relative"}}>{bindings.slice(first,first+14).map((binding,index)=><button className="annotation-binding-row" style={{position:"absolute",top:(first+index)*108,height:100}} key={binding.id} disabled={!onSelect||binding.status!=="active"||binding.kind==="range"} onClick={()=>onSelect?.(binding)}><span>{binding.anchor.chapter?.label||binding.anchor.start?.label||t("Preamble")}{binding.kind==="range"?` → ${binding.anchor.end?.label||t("Preamble")}`:""}</span>{binding.kind==="small"&&<blockquote>{binding.quote.slice(0,160)}</blockquote>}<small>{t(binding.status)}</small></button>)}</div></div>;
}
