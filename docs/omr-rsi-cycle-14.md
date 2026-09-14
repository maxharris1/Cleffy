# OMR RSI cycle 14

**Pending next host bench; accepted baseline remains 7/16 at `f796059`
(svc-19).** This is the first handoff of the new locked split loop. Astra
implements and pushes; the host runs OMR and the official
`services/omr-service/src/eval/` suite. No official host results were supplied
for this turn, so this candidate is neither accepted nor rejected.

## Hypothesis → layer → diff

One hypothesis:
`bach-prelude-bwv939` has two horizontal upper ties assigned to C5 because
`SlurLinker` tests the far head edge against curve concavity. The lower
of these curves belongs to the printed A4. Luna implemented the isolated
head-selection candidate; Astra narrowed it to horizontal curves. Attribution
awaits the next host suite table. No currently passing piece may go red.

The candidate uses the head center for the horizontal concavity test and
preserves the original bounds-edge rule for nonhorizontal slurs. Distance
ranking and all tie/pitch checks remain. It does not copy ties between chord
heads. Kill criteria: any protected pass turns red, any accepted tie is lost
without page evidence, or gains require invented curves or altered scoring.

The source is vendored as `engine-patches/src/org/audiveris/omr/sheet/curve/SlurLinker.java`
with reproducible upstream diff `0005-slur-head-concavity.patch`. The Dockerfile
compiles it into the engine jar and `ENGINE_VERSION` is bumped to svc-20 so the
host gets a separate artifact cache. No engine option, parser, scorer, pin,
floor, or allowance changes. Original 300-dpi options and the deployed-generation
setting remain unchanged. The [tie-head localization packet](omr-rsi-bwv939-tie-head-localization.md)
records the printed curves and the incorrect OMR relations.

## Candidate identity and validation

The preserved cycle 14 source was recovered from the pre-split saved candidate
with its recorded hash intact. Its algorithm was not changed for this handoff.
Svc-20 `SlurLinker.java` SHA256:
`463c486183d85a64e295acac2fe0d411711b73a080c39e8ee2434bb843494c10`.

Prior WIP build metadata, not rebuilt or inspected by the implementer in this
split turn: image `cleffy-omr-rsi:svc-20` SHA256:
`03fcf4c3aa06873929c86e900e7ce7c79110c4770432bdd65a4a411ddbc3949e`.
Jar SHA256:
`b84c197310644f38b271f31bb212733610c5d2e7b3d482e037306c5e1ddcd903`.

Current-turn service build and typecheck pass; all **509 unit tests** pass
(29 files). These tests use fixtures and fake engine processes. The upstream
patch reproduces the preserved vendored source byte for byte. No Docker build,
Audiveris execution, or benchmark is run by this implementer.

## Next host bench → verdict

The host must use the matching svc-20 engine and fresh engine exports on the
same pinned inputs, scoring with `services/omr-service/src/eval/`:

```sh
CLEFFY_OMR_CONTAINER=cleffy-rsi-omr-20 npm run eval -- bench --force-audiveris
```

Suite delta and verdict remain pending that host result. Existing local bench
file modifications are outside this handoff and are not an acceptance source.
The earlier isolated probe removed one extra A4 attack; it is not a BWV 939 or
corpus pass claim. The three other missing ties remain independent failures.
The host must confirm the lower of the two upper curves links A4→A4, the upper C5 curve
remains C5→C5, and the lower E4 curve remains E4→E4, then attribute every suite
change and apply the kill criteria above. The accepted baseline stays **7/16**.
