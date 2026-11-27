#!/bin/sh
# Fails unless every viewer scene of #206's screenshot set has a desktop, tablet and phone capture at <rev>.
rev=${1:-HEAD}
dir=shots/5bbd72b66473f2d24a59fc40dbf8ed3101d52c28
have=$(git ls-tree -r --name-only "$rev" -- "$dir")
missing=0
for scene in owner student starting-point signed-out-ink link link-busy loading error; do
    for vp in desktop-1440 ipad-portrait iphone-14; do
        echo "$have" | grep -qx "$dir/$scene-$vp.png" || { echo "missing $scene-$vp.png"; missing=1; }
    done
done
[ "$missing" = 0 ] && echo "all 24 captures present at $rev"
exit "$missing"
