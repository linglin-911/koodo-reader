import {useMemo} from "react";
import type {CSSProperties} from "react";
import {useAppStore} from "../../store/useAppStore";
import {ConfigService} from "../../assets/lib/kookit-extra-browser.min";
export function useAnnotationPalette(reader=false):CSSProperties{
 const background=useAppStore(state=>state.reader.backgroundColor);
 const skin=ConfigService.getReaderConfig("appSkin"),night=skin==="night"||(skin==="system"&&ConfigService.getReaderConfig("isOSNight")==="yes");
 return useMemo(()=>{const surface=reader&&background&&background!=="transparent"&&background!=="rgba(0,0,0,0)"?background:night?"#2c2f31":"#ffffff";
  const probe=document.createElement("span");probe.style.color=surface;document.body.append(probe);const channels=getComputedStyle(probe).color.match(/[\d.]+/g)?.slice(0,3).map(Number)||[255,255,255];probe.remove();const dark=channels[0]*.2126+channels[1]*.7152+channels[2]*.0722<135;
  const ink=reader&&ConfigService.getReaderConfig("textColor")|| (dark?"#eeeeee":"#333333");return {"--background-color":surface,"--text-color":ink,color:ink} as CSSProperties;
 },[background,reader,night]);
}
