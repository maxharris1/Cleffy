import { useParams } from 'react-router';

export const JoinPage = () => {
    const { token } = useParams<{ token: string }>();

    return (
        <main className="flex min-h-full items-center justify-center p-8">
            <p className="text-stone-500">Join link {token?.slice(0, 6)}… — coming in M3.</p>
        </main>
    );
};
