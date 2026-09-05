# Track A — cheap geometry vs reference boxes

Reference: MuseScore `.mpos` measure boxes for typeset scores; Audiveris 5.6.1 `.omr` for scans. `recall` = share of reference bars found on the right page/system with overlapping x; `xIoU` = mean 1-D IoU of found bars; `sys` = systems detected / reference.

| score | kind | pages | variant | ms | sys | bars | ref bars | recall | precision | xIoU | ≥0.8 | bars w/ columns |
|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| bach-prelude-846 | typeset | 3 | cv | 956 | 14/14 | 35 | 35 | 1.000 | 1.000 | 0.995 | 1.000 | 35 |
| bach-prelude-846 | typeset | 3 | grid | 4622 | 14/14 | 35 | 35 | 1.000 | 1.000 | 0.996 | 1.000 | 0 |
| bach-fugue-846 | typeset | 4 | cv | 1271 | 16/16 | 27 | 27 | 1.000 | 1.000 | 0.995 | 1.000 | 27 |
| bach-fugue-846 | typeset | 4 | grid | 4846 | 16/16 | 28 | 27 | 1.000 | 0.964 | 0.982 | 0.963 | 0 |
| bach-prelude-848 | typeset | 3 | cv | 1189 | 17/17 | 104 | 104 | 1.000 | 1.000 | 0.987 | 1.000 | 104 |
| bach-prelude-848 | typeset | 3 | grid | 4646 | 17/17 | 119 | 104 | 1.000 | 0.874 | 0.945 | 0.904 | 0 |
| beethoven-8-2 | typeset | 8 | cv | 2175 | 27/27 | 78 | 73 | 1.000 | 0.936 | 0.977 | 0.973 | 76 |
| beethoven-8-2 | typeset | 8 | grid | 7271 | 27/27 | 74 | 73 | 1.000 | 0.987 | 0.994 | 1.000 | 0 |
| haydn-39-3 | typeset | 5 | cv | 1593 | 28/28 | 123 | 121 | 1.000 | 0.984 | 0.970 | 0.959 | 121 |
| haydn-39-3 | typeset | 5 | grid | 5841 | 28/28 | 128 | 121 | 0.967 | 0.914 | 0.948 | 0.876 | 0 |
| mozart-11-3 | typeset | 5 | cv | 1873 | 29/29 | 141 | 137 | 1.000 | 0.972 | 0.974 | 0.971 | 141 |
| mozart-11-3 | typeset | 5 | grid | 6279 | 29/29 | 152 | 137 | 1.000 | 0.901 | 0.956 | 0.898 | 0 |
| mozart-12-2 | typeset | 6 | cv | 1825 | 25/25 | 41 | 40 | 1.000 | 0.976 | 0.996 | 1.000 | 40 |
| mozart-12-2 | typeset | 6 | grid | 6726 | 25/25 | 52 | 40 | 1.000 | 0.769 | 0.909 | 0.825 | 0 |
| chopin-10-3 | typeset | 7 | cv | 2209 | 26/26 | 78 | 78 | 1.000 | 1.000 | 0.993 | 1.000 | 77 |
| chopin-10-3 | typeset | 7 | grid | 7386 | 26/26 | 90 | 78 | 1.000 | 0.867 | 0.965 | 0.936 | 0 |
| scriabin-8-11 | typeset | 3 | cv | 1117 | 15/15 | 53 | 54 | 0.982 | 1.000 | 0.966 | 0.944 | 52 |
| scriabin-8-11 | typeset | 3 | grid | 4753 | 15/15 | 56 | 54 | 1.000 | 0.964 | 0.986 | 0.982 | 0 |
| ravel-pavane | typeset | 4 | cv | 1594 | 20/20 | 68 | 72 | 0.944 | 1.000 | 0.960 | 0.889 | 68 |
| ravel-pavane | typeset | 4 | grid | 5793 | 20/20 | 75 | 72 | 1.000 | 0.960 | 0.978 | 0.958 | 0 |
| bach-846-prelude-fugue | typeset | 7 | cv | 1990 | 30/30 | 62 | 62 | 1.000 | 1.000 | 0.995 | 1.000 | 62 |
| bach-846-prelude-fugue | typeset | 7 | grid | 6913 | 30/30 | 63 | 62 | 1.000 | 0.984 | 0.990 | 0.984 | 0 |
| bach-prelude-846-scan | scan | 2 | cv | 1151 | 12/12 | 35 | 34 | 1.000 | 0.971 | 0.996 | 1.000 | 35 |
| bach-prelude-846-scan | scan | 2 | grid | 5598 | 12/12 | 35 | 34 | 1.000 | 0.971 | 0.998 | 1.000 | 0 |
| bach-fugue-846-scan | scan | 2 | cv | 1254 | 12/12 | 27 | 27 | 1.000 | 1.000 | 0.997 | 1.000 | 27 |
| bach-fugue-846-scan | scan | 2 | grid | 5512 | 12/12 | 30 | 27 | 1.000 | 0.900 | 0.975 | 0.963 | 0 |
| beethoven-8-2-scan | scan | 3 | cv | 2652 | 19/19 | 71 | 73 | 0.973 | 1.000 | 0.975 | 0.945 | 71 |
| beethoven-8-2-scan | scan | 3 | grid | 9542 | 19/19 | 77 | 73 | 1.000 | 0.948 | 0.987 | 0.973 | 0 |
| beethoven-8-2-scan-berg | scan | 4 | cv | 3319 | 20/— | 71 | — | — | — | — | — | 71 |
| beethoven-8-2-scan-berg | scan | 4 | grid | 8519 | 20/— | 75 | — | — | — | — | — | 0 |
| haydn-39-3-scan | scan | 4 | cv | 2312 | 19/24 | 97 | 121 | 0.537 | 0.670 | 0.664 | 0.207 | 94 |
| haydn-39-3-scan | scan | 4 | grid | 8845 | 24/24 | 130 | 121 | 1.000 | 0.931 | 0.968 | 0.926 | 0 |
| mozart-11-3-scan | scan | 4 | cv | 2090 | 20/24 | 137 | 137 | 0.774 | 0.774 | 0.815 | 0.547 | 108 |
| mozart-11-3-scan | scan | 4 | grid | 9286 | 24/24 | 160 | 137 | 1.000 | 0.856 | 0.944 | 0.876 | 0 |
| chopin-10-3-scan | scan | 4 | cv | 2435 | 18/20 | 69 | 74 | 0.865 | 0.927 | 0.961 | 0.797 | 69 |
| chopin-10-3-scan | scan | 4 | grid | 9832 | 20/20 | 81 | 74 | 1.000 | 0.914 | 0.968 | 0.932 | 0 |
| scriabin-8-11-scan | scan | 3 | cv | 2636 | 17/17 | 53 | 54 | 0.963 | 0.981 | 0.983 | 0.944 | 53 |
| scriabin-8-11-scan | scan | 3 | grid | 7958 | 17/17 | 55 | 54 | 1.000 | 0.982 | 0.998 | 1.000 | 0 |

**cv**: 18 scores, mean recall 0.947, mean xIoU 0.956, mean ms/page 464, systems exact 15/18, bar count exact 7/18

**grid**: 18 scores, mean recall 0.998, mean xIoU 0.971, mean ms/page 1789, systems exact 18/18, bar count exact 1/18
