import type { AnnotationKind, BindingInput } from "../../utils/storage/annotationService";
export const QUICK_ANNOTATION = "koodo:quick-annotation";
export const ANNOTATION_HIT = "koodo:annotation-hit";
export const ANNOTATION_QUERY = "koodo:annotation-query";
export interface QuickRequest { kind: AnnotationKind; binding?: BindingInput; append?: boolean; noteKey?: string; selection?: boolean; }
export interface HitRequest { key: string; bindingId: string; x: number; y: number; }
export const openQuickAnnotation = (request: QuickRequest) => window.dispatchEvent(new CustomEvent(QUICK_ANNOTATION,{detail:request}));
