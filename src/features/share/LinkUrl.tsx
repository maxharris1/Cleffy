export const LinkUrl = ({
    url,
    keepLast = 8,
    className = '',
}: {
    url: string;
    keepLast?: number;
    className?: string;
}) => (
    <span className={`flex ${className}`} title={url}>
        <span className="w-0 grow truncate">{url.slice(0, -keepLast)}</span>
        <span className="shrink-0">{url.slice(-keepLast)}</span>
    </span>
);
