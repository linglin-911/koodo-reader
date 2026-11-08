import { useEffect, useRef, useState } from "react";
import { AnnotationEntity, AnnotationService } from "../storage/annotationService";

/** UI summaries are a page, never a request for every entity or note body. */
export function useAnnotationPage(enabled: boolean, filter: Record<string, unknown>, revision: unknown) {
  const key = JSON.stringify(filter), [cursor,setCursor]=useState({key,offset:0});
  const offset=cursor.key===key?cursor.offset:0;
  const [state,setState]=useState({records:[] as AnnotationEntity[],hasMore:false,loading:false,error:""});
  const version=useRef(0);
  useEffect(()=>{
    const request=++version.current;if(!enabled)return;
    setState(previous=>({...previous,loading:true,error:""}));
    void AnnotationService.list({...JSON.parse(key),offset,limit:100}).then(page=>{
      if(version.current===request)setState({...page,loading:false,error:""});
    }).catch(error=>{if(version.current===request)setState({records:[],hasMore:false,loading:false,error:String(error)});});
    return ()=>{version.current++;};
  },[enabled,key,offset,revision]);
  return {...state,offset,next:()=>setCursor({key,offset:offset+100}),previous:()=>setCursor({key,offset:Math.max(0,offset-100)})};
}
