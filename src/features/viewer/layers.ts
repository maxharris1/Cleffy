import type { LayerAudience } from '@/features/viewer/layerAudience';
import { useViewerStore } from '@/state/store';
import type { Annotation, AnnotationLayer, AnnotationPayload } from '@/types/models';

export type { LayerAudience } from '@/features/viewer/layerAudience';

/** Missing `layer` is teacher, so lessons written before layers stay visible. */
export const annotationLayer = (payload: { layer?: AnnotationLayer } | null | undefined): AnnotationLayer =>
    payload?.layer === 'student' ? 'student' : 'teacher';

export const withActiveLayer = <T extends object>(payload: T): T & { layer: AnnotationLayer } => {
    const layer = useViewerStore.getState().markLayer;
    return { ...payload, layer };
};

/**
 * Mirrors public.annotation_row_visible:
 * owner (and a local file) sees both layers; everyone sees teacher marks;
 * a student sees their own student marks; other members see the student
 * layer only after the owner shares it.
 * A row still waiting on the server has createdBy null — it is this device's.
 */
export const annotationVisible = (annotation: Annotation, audience: LayerAudience): boolean => {
    if (audience.role === 'owner' || audience.role === 'local') {
        return true;
    }
    if (annotationLayer(annotation.payload) !== 'student') {
        return true;
    }
    if (!annotation.createdBy || annotation.createdBy === audience.userId) {
        return true;
    }
    return audience.shareStudentLayer;
};

export const filterVisibleAnnotations = (annotations: Annotation[]): Annotation[] => {
    const audience = useViewerStore.getState().layerAudience;
    return annotations.filter((annotation) => annotationVisible(annotation, audience));
};

/** Publish who is looking without notifying when nothing changed. */
export const publishLayerAudience = (audience: LayerAudience): void => {
    const current = useViewerStore.getState().layerAudience;
    const markLayer = audience.canUseTeacherLayer ? useViewerStore.getState().markLayer : 'student';
    if (
        current.userId === audience.userId &&
        current.role === audience.role &&
        current.shareStudentLayer === audience.shareStudentLayer &&
        current.canUseTeacherLayer === audience.canUseTeacherLayer &&
        current.canShareStudentLayer === audience.canShareStudentLayer &&
        useViewerStore.getState().markLayer === markLayer
    ) {
        return;
    }
    useViewerStore.setState({ layerAudience: audience, markLayer });
};

export const layerOfPayload = (payload: AnnotationPayload): AnnotationLayer => annotationLayer(payload);
