/**
 * "Anonymous <animal>": what a signed-out link viewer, a link guest who gave
 * no name, and any presence entry that is not a member of the score are
 * called (Share v2, R4). The animal comes from a hash of the id, so the same
 * visitor keeps the same animal for as long as their id lasts, and nothing
 * about them is stored to get it.
 */
export const ANIMALS: readonly string[] = [
    'Aardvark',
    'Albatross',
    'Alpaca',
    'Antelope',
    'Armadillo',
    'Badger',
    'Beaver',
    'Bison',
    'Bobcat',
    'Butterfly',
    'Camel',
    'Capybara',
    'Caribou',
    'Chameleon',
    'Cheetah',
    'Chinchilla',
    'Coyote',
    'Crane',
    'Dolphin',
    'Dove',
    'Duck',
    'Eagle',
    'Elephant',
    'Falcon',
    'Ferret',
    'Finch',
    'Flamingo',
    'Fox',
    'Gazelle',
    'Gecko',
    'Giraffe',
    'Goose',
    'Hare',
    'Hedgehog',
    'Heron',
    'Hummingbird',
    'Ibis',
    'Jaguar',
    'Kangaroo',
    'Kingfisher',
    'Koala',
    'Lemur',
    'Leopard',
    'Llama',
    'Lynx',
    'Manatee',
    'Meerkat',
    'Moose',
    'Narwhal',
    'Ocelot',
    'Octopus',
    'Otter',
    'Owl',
    'Panda',
    'Pangolin',
    'Pelican',
    'Penguin',
    'Puffin',
    'Quokka',
    'Rabbit',
    'Raccoon',
    'Raven',
    'Robin',
    'Salamander',
    'Seal',
    'Sparrow',
    'Squirrel',
    'Swan',
    'Tapir',
    'Tiger',
    'Toucan',
    'Turtle',
    'Walrus',
    'Wombat',
    'Wren',
    'Yak',
    'Zebra',
];

/** FNV-1a over the id's UTF-16 code units: small, stable, well spread. */
const hash = (id: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
};

export const animalFor = (id: string): string => ANIMALS[hash(id) % ANIMALS.length]!;

export const anonymousName = (id: string): string => `Anonymous ${animalFor(id)}`;
