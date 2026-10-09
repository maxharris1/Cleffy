import { ensureMusicFontLoaded } from '@/features/viewer/ink/musicFont';

/** Load Bravura when Print turns on so the first on-device symbol measures the music face. */
export const warmPrintPipeline = (): void => {
    void ensureMusicFontLoaded();
};
