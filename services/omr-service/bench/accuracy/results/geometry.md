# Track A — cheap geometry vs reference boxes

Reference: MuseScore `.mpos` measure boxes for typeset scores; Audiveris 5.6.1 `.omr` for scans. `recall` = share of reference bars found on the right page/system with overlapping x; `xIoU` = mean 1-D IoU of found bars; `sys` = systems detected / reference.

| score | kind | pages | variant | ms | sys | bars | ref bars | recall | precision | xIoU | ≥0.8 | bars w/ columns |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| bach-prelude-846 | typeset | 3 | cv | 752 | 14/14 | 35 | 35 | 1.000 | 1.000 | 0.995 | 1.000 | 35 |
| bach-prelude-846 | typeset | 3 | grid | 4939 | 14/14 | 35 | 35 | 1.000 | 1.000 | 0.996 | 1.000 | 0 |
| bach-fugue-846 | typeset | 4 | cv | 917 | 16/16 | 27 | 27 | 1.000 | 1.000 | 0.995 | 1.000 | 27 |
| bach-fugue-846 | typeset | 4 | grid | 5320 | 16/16 | 28 | 27 | 1.000 | 0.964 | 0.982 | 0.963 | 0 |
| bach-prelude-848 | typeset | 3 | cv | 917 | 17/17 | 104 | 104 | 1.000 | 1.000 | 0.987 | 1.000 | 104 |
| bach-prelude-848 | typeset | 3 | grid | 5299 | 17/17 | 119 | 104 | 1.000 | 0.874 | 0.945 | 0.904 | 0 |
| beethoven-8-2 | typeset | 8 | cv | 1586 | 27/27 | 78 | 73 | 1.000 | 0.936 | 0.977 | 0.973 | 76 |
| beethoven-8-2 | typeset | 8 | grid | 7874 | 27/27 | 74 | 73 | 1.000 | 0.987 | 0.994 | 1.000 | 0 |
| haydn-39-3 | typeset | 5 | cv | 1186 | 28/28 | 123 | 121 | 1.000 | 0.984 | 0.970 | 0.959 | 121 |
| haydn-39-3 | typeset | 5 | grid | 6518 | 28/28 | 128 | 121 | 0.967 | 0.914 | 0.948 | 0.876 | 0 |
| mozart-11-3 | typeset | 5 | cv | 1362 | 29/29 | 141 | 137 | 1.000 | 0.972 | 0.974 | 0.971 | 141 |
| mozart-11-3 | typeset | 5 | grid | 6732 | 29/29 | 152 | 137 | 1.000 | 0.901 | 0.956 | 0.898 | 0 |
| mozart-12-2 | typeset | 6 | cv | 1349 | 25/25 | 41 | 40 | 1.000 | 0.976 | 0.996 | 1.000 | 40 |
| mozart-12-2 | typeset | 6 | grid | 6675 | 25/25 | 52 | 40 | 1.000 | 0.769 | 0.909 | 0.825 | 0 |
| chopin-10-3 | typeset | 7 | cv | 1705 | 26/26 | 78 | 78 | 1.000 | 1.000 | 0.993 | 1.000 | 77 |
| chopin-10-3 | typeset | 7 | grid | 7793 | 26/26 | 90 | 78 | 1.000 | 0.867 | 0.965 | 0.936 | 0 |
| scriabin-8-11 | typeset | 3 | cv | 879 | 15/15 | 53 | 54 | 0.982 | 1.000 | 0.966 | 0.944 | 52 |
| scriabin-8-11 | typeset | 3 | grid | 5548 | 15/15 | 56 | 54 | 1.000 | 0.964 | 0.986 | 0.982 | 0 |
| ravel-pavane | typeset | 4 | cv | 1252 | 20/20 | 68 | 72 | 0.944 | 1.000 | 0.960 | 0.889 | 68 |
| ravel-pavane | typeset | 4 | grid | 6270 | 20/20 | 75 | 72 | 1.000 | 0.960 | 0.978 | 0.958 | 0 |
| bach-846-prelude-fugue | typeset | 7 | cv | 1447 | 30/30 | 62 | 62 | 1.000 | 1.000 | 0.995 | 1.000 | 62 |
| bach-846-prelude-fugue | typeset | 7 | grid | 7299 | 30/30 | 63 | 62 | 1.000 | 0.984 | 0.990 | 0.984 | 0 |
| bach-prelude-846-scan | scan | 2 | cv | 807 | 6/12 | 18 | 34 | 0.500 | 0.944 | 0.998 | 0.500 | 18 |
| bach-prelude-846-scan | scan | 2 | grid | 5913 | 12/12 | 35 | 34 | 1.000 | 0.971 | 0.998 | 1.000 | 0 |
| bach-fugue-846-scan | scan | 2 | cv | 833 | 12/12 | 27 | 27 | 1.000 | 1.000 | 0.997 | 1.000 | 27 |
| bach-fugue-846-scan | scan | 2 | grid | 5512 | 12/12 | 30 | 27 | 1.000 | 0.900 | 0.975 | 0.963 | 0 |
| beethoven-8-2-scan | scan | 3 | cv | 2014 | 19/— | 71 | — | — | — | — | — | 71 |
| beethoven-8-2-scan | scan | 3 | grid | 9644 | 19/— | 77 | — | — | — | — | — | 0 |
| beethoven-8-2-scan-berg | scan | 4 | cv | 2765 | 20/— | 71 | — | — | — | — | — | 71 |
| beethoven-8-2-scan-berg | scan | 4 | grid | 8884 | 20/— | 75 | — | — | — | — | — | 0 |
| haydn-39-3-scan | scan | 4 | cv | 1837 | 19/— | 97 | — | — | — | — | — | 94 |
| haydn-39-3-scan | scan | 4 | grid | 9155 | 24/— | 130 | — | — | — | — | — | 0 |
| mozart-11-3-scan | scan | 4 | cv | 1753 | 20/— | 137 | — | — | — | — | — | 108 |
| mozart-11-3-scan | scan | 4 | grid | 10030 | 24/— | 160 | — | — | — | — | — | 0 |
| chopin-10-3-scan | scan | 4 | cv | 1927 | 16/— | 75 | — | — | — | — | — | 72 |
| chopin-10-3-scan | scan | 4 | grid | 9969 | 20/— | 81 | — | — | — | — | — | 0 |
| scriabin-8-11-scan | scan | 3 | cv | 2248 | 17/— | 53 | — | — | — | — | — | 53 |
| scriabin-8-11-scan | scan | 3 | grid | 8036 | 17/— | 55 | — | — | — | — | — | 0 |

**cv**: 13 scores, mean recall 0.956, mean xIoU 0.985, mean ms/page 277, systems exact 12/13, bar count exact 6/13

**grid**: 13 scores, mean recall 0.997, mean xIoU 0.971, mean ms/page 1598, systems exact 13/13, bar count exact 1/13
