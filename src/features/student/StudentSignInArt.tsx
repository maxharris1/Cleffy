import '@/features/marketing/handwriting.css';

import { useHandwritingFont } from '@/features/marketing/useHandwritingFont';
import { StudentCodeCard } from '@/features/roster/StudentCodeCard';

export const StudentSignInArt = () => {
    const handwritingLoaded = useHandwritingFont() === 'loaded';
    return (
        <div className={`w-[min(430px,100%)]${handwritingLoaded ? '' : ' score-ink-pending'}`}>
            <StudentCodeCard
                displayName="Leo Martin"
                loginCode="K7QM-2HXP-9RTD"
                teacherName="Ms. Davis"
                site="cleffy.io"
                printable={false}
                className="-rotate-[1.6deg]"
            />
            <p className="mt-[30px] text-center">
                <span className="font-hand inline-block -rotate-2 text-[30px] leading-[1.1] font-bold text-ink-hand">
                    hand this over at the lesson
                </span>
            </p>
        </div>
    );
};
