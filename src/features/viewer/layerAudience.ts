/**
 * Who is looking, for the same rule the annotations SELECT policy enforces.
 * `local` is a file opened on this device: one person, both layers.
 */
export interface LayerAudience {
    userId: string;
    role: 'owner' | 'editor' | 'viewer' | 'local';
    /** documents.share_student_layer. Absent on old rows means not shared. */
    shareStudentLayer: boolean;
    /** Roster students cannot stamp or edit the teacher layer. Owners always can. */
    canUseTeacherLayer: boolean;
    /** Only the score owner flips the document flag. */
    canShareStudentLayer: boolean;
}

export const DEFAULT_LAYER_AUDIENCE: LayerAudience = {
    userId: '',
    role: 'local',
    shareStudentLayer: false,
    canUseTeacherLayer: true,
    canShareStudentLayer: false,
};
