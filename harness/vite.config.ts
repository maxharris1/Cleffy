import { fileURLToPath, URL } from 'node:url';

import { mergeConfig, type UserConfig } from 'vite';

import base from '../vite.config';

const mock = (name: string) => fileURLToPath(new URL(`./mocks/${name}.ts`, import.meta.url));
const baseConfig = base as UserConfig;

export default mergeConfig(
    { ...baseConfig, resolve: { ...baseConfig.resolve, alias: undefined } },
    {
        resolve: {
            alias: [
                { find: /^@\/features\/share\/shareService$/, replacement: mock('shareService') },
                { find: /^@\/features\/notes\/notesService$/, replacement: mock('notesService') },
                { find: /^@\/features\/viewer\/history\/snapshotService$/, replacement: mock('snapshotService') },
                { find: /^@\/features\/auth\/session$/, replacement: mock('session') },
                { find: /^@\//, replacement: fileURLToPath(new URL('../src/', import.meta.url)) },
            ],
        },
    },
);
