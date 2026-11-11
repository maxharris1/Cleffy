import type { InstallSurface } from '@/features/install/installSurface';
import { isIosDevice, isIpadDevice, resolveInstallSurface, shareBarCopy } from '@/features/install/installSurface';
import { Dialog } from '@/ui/Dialog';
import { ShareIcon } from '@/ui/icons';

export interface AddToHomeScreenDialogProps {
    onClose: () => void;
    surface?: InstallSurface;
}

const leadCopy = (surface: InstallSurface): string | null => {
    switch (surface) {
        case 'standalone':
            return 'The library is already running as an app on this Home Screen.';
        case 'ios-safari':
            return null;
        case 'ios-other':
            return 'Open this page in Safari first — Home Screen shortcuts only work from Safari.';
        case 'installable':
        case 'other':
            return 'On the iPhone or iPad, open cleffy.io in Safari.';
        default: {
            const _never: never = surface;
            return _never;
        }
    }
};

const shareStepCopy = (): string => {
    if (!isIosDevice()) {
        return shareBarCopy();
    }
    if (isIpadDevice()) {
        return 'in the top toolbar';
    }
    return 'in the bar at the bottom of Safari';
};

/**
 * Visual Safari steps for putting the library on an iPhone or iPad Home Screen.
 * iOS cannot install from the page itself — Share → Add to Home Screen is the path.
 */
export const AddToHomeScreenDialog = ({ onClose, surface = resolveInstallSurface() }: AddToHomeScreenDialogProps) => {
    const lead = leadCopy(surface);
    const sharePlace = shareStepCopy();

    return (
        <Dialog label="Add to Home Screen" onClose={onClose} sheet>
            <div className="flex flex-col items-center pb-1">
                <img
                    src="/icons/apple-touch-icon.png"
                    alt=""
                    width={72}
                    height={72}
                    className="h-[72px] w-[72px] rounded-[1.15rem] shadow-sm ring-1 ring-stone-200/80"
                />
                <p className="mt-2 text-sm font-medium text-stone-800">Cleffy</p>
            </div>

            {lead ? <p className="mt-4 text-sm text-stone-700">{lead}</p> : null}

            <ol className="mt-4 flex flex-col gap-3">
                <li className="flex gap-3 text-sm text-stone-700">
                    <span
                        aria-hidden="true"
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
                    >
                        1
                    </span>
                    <span>
                        Tap{' '}
                        <span className="inline-flex items-center gap-1 font-medium text-stone-800">
                            Share
                            <ShareIcon size={16} className="inline-block text-stone-800" />
                        </span>
                        {isIosDevice() ? ` ${sharePlace}.` : ` — ${sharePlace}`}
                    </span>
                </li>
                <li className="flex gap-3 text-sm text-stone-700">
                    <span
                        aria-hidden="true"
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
                    >
                        2
                    </span>
                    <span>
                        Tap <span className="font-medium text-stone-800">Add to Home Screen</span>
                    </span>
                </li>
                <li className="flex gap-3 text-sm text-stone-700">
                    <span
                        aria-hidden="true"
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
                    >
                        3
                    </span>
                    <span>
                        Tap <span className="font-medium text-stone-800">Add</span>
                    </span>
                </li>
            </ol>
        </Dialog>
    );
};
