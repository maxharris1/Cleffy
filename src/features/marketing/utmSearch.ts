import { UTM_KEYS, UTM_VALUE, type UtmKey } from '@/lib/attribution';

const isUtmKey = (key: string): key is UtmKey => (UTM_KEYS as readonly string[]).includes(key);

/**
 * The query to carry from the landing page on to /try and /register: the
 * page's own utm_ tags (lib/attribution), in the order they came, and
 * nothing else from the query string. '' when there are none.
 */
export const utmSearch = (search: string): string => {
    const kept = new URLSearchParams();
    for (const [key, value] of new URLSearchParams(search)) {
        if (isUtmKey(key) && UTM_VALUE.test(value) && !kept.has(key)) {
            kept.append(key, value);
        }
    }
    const query = kept.toString();
    return query ? `?${query}` : '';
};
