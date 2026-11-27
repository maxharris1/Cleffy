import '@/features/marketing/handwriting.css';

import { ScoreInk } from '@/features/marketing/ScoreInk';
import { useHandwritingReady } from '@/features/marketing/useHandwritingReady';

const SENTENCE = {
    register: 'Free for 3 cloud scores. Annotation is unlimited on every plan.',
    default: 'Your teacher, your section and your own devices all open the same page.',
} as const;

export type SignInArtSentence = keyof typeof SENTENCE;

const Presence = ({ name, color }: { name: string; color: string }) => (
    <span className="inline-flex h-[30px] items-center gap-2 rounded-full bg-paper/10 pr-3 pl-2.5 text-[13px] font-semibold whitespace-nowrap text-paper shadow-[0_0_0_1px_rgb(247_245_239/0.24)]">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        {name}
    </span>
);

export const SignInArt = ({ sentence = 'default' }: { sentence?: SignInArtSentence }) => {
    const handwritingReady = useHandwritingReady();
    return (
        <div className={`score-ink-still w-[min(560px,100%)]${handwritingReady ? '' : ' score-ink-pending'}`}>
            <div className="-rotate-[1.4deg] rounded-[8px] bg-white px-[26px] pt-[26px] pb-5 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.8)]">
                <ScoreInk alt="" size="hero" />
            </div>
            <div className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-2.5">
                <Presence name="Ms. Davis" color="#dc2626" />
                <Presence name="Leo" color="#2563eb" />
                <span className="ml-1.5">
                    <span className="font-hand inline-block -rotate-2 text-[28px] leading-[1.1] font-bold text-ink-hand">
                        both on this page, right now
                    </span>
                </span>
            </div>
            <p className="mt-4 text-base leading-normal text-pretty text-[#d6d3d1]">{SENTENCE[sentence]}</p>
        </div>
    );
};
