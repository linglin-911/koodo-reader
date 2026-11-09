import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { throttle } from "../../utils/common";
import { useEffect, useMemo } from "react";
import "./quick.css";
export interface ChapterChoice { index:number; chapterId:string; label:string; }
interface Props { chapters:ChapterChoice[]; value:number; onChange:(index:number)=>void; label:string; disabled?:boolean; }
// Only metadata is retained. At most twelve chapter buttons are mounted.
export default function ChapterPicker({chapters,value,onChange,label,disabled}:Props) {
  const {t}=useTranslation(),[open,setOpen]=useState(false),[top,setTop]=useState(0);
  const viewport=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{if(open&&viewport.current){const position=Math.max(0,chapters.findIndex(chapter=>chapter.index===value)*36-36);viewport.current.scrollTop=position;setTop(position);}},[open]);
  const onScroll=useMemo(()=>throttle((offset:number)=>setTop(offset),40),[]);
  useEffect(()=>()=>onScroll.cancel(),[onScroll]);
  const first=Math.max(0,Math.floor(top/36)-2),rows=chapters.slice(first,first+12),selected=chapters.find(chapter=>chapter.index===value);
  return <div className="annotation-chapter-picker"><button disabled={disabled} aria-label={t(label)} aria-expanded={open} onClick={()=>{setOpen(!open);setTop(0);}}>{t(label)} · {selected?.label||t("Unbound annotation")}</button>
    {open&&<div ref={viewport} className="annotation-chapter-viewport" onScroll={event=>onScroll(event.currentTarget.scrollTop)}><div style={{height:chapters.length*36,position:"relative"}}>{rows.map((chapter,index)=><button key={chapter.chapterId} style={{position:"absolute",top:(first+index)*36,height:36,left:0,right:0}} aria-pressed={chapter.index===value} onClick={()=>{onChange(chapter.index);setOpen(false);}}>{chapter.index+1}. {chapter.label||t("Preamble")}</button>)}</div></div>}
  </div>;
}
