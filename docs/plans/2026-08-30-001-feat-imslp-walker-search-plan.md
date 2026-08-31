---
title: IMSLP Walker Search - Plan
type: feat
date: 2026-08-30
topic: imslp-walker-search
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# IMSLP Walker Search - Plan

## Goal Capsule

**Objective.** A teacher can get any IMSLP work into the studio with less friction: chips show the same set IMSLP’s Category Walker would; typing reaches the rest of the archive without the default Piano chip or era surnames distorting the query.

**Product authority.** Chip meaning, default vs intersection browse, membership cache, and typed-search filter hygiene. Work-page fetch and license gates stay as they are.

**Stop conditions.** Do not fall back to surname seeds.

**Open blockers.** None.

## Product Contract

### Summary

Every chip is one IMSLP category. Two or more chips show the Walker intersection. Default Piano-only stays Popular. Typed search is live IMSLP and is not hard-filtered by the default Piano chip; era surnames are not injected into `srsearch`.

### Key Decisions

- Archive truth over catalog-only or surname seeds. (session-settled: user-directed) Governs R1, R2, R6.
- Split Modern into Early 20th century and Modern. (session-settled: user-directed) Governs R3.
- Popular then Walker. (session-settled: user-directed) Governs R4, R5.
- Cache intersections. Governs R7.
- Any piece via type. (session-settled: user-directed — same PR as chips) Governs R8, R11, R12, R13.

### Requirements

- R1. Instrument, form, era, and composer chips map to one IMSLP category each. No surname-list chips.
- R2. Era chips: Baroque, Classical, Romantic, Early 20th century, Modern.
- R3. Debussy / Ravel / Rachmaninoff live on Early 20th century, not Modern.
- R4. Default Piano-only, empty query → Popular. No IMSLP listing claimed.
- R5. Any extra chip + empty query → Walker intersection of active category chips. Key is not a category.
- R6. Triple intersections use the same rule. Empty is allowed only when the full intersection is known.
- R7. Browse paints from a maintained membership cache (bootstrap snapshot or synced table), not a 160-page live walk.
- R8. Typed query (2+ characters) uses live IMSLP text search.
- R9. Status names the categories in force when R5 answers.
- R10. “Nothing on IMSLP matches these filters” only when the intersection is complete and empty.
- R11. A work on IMSLP and not in Popular is reachable by typing.
- R12. Default Piano-only does not hard-filter a typed query. An instrument the user selects (or Piano plus another chip) may.
- R13. Era chips do not append composer surnames to `srsearch` or `facetTokens`.

### Acceptance Examples

- AE1. Piano · Baroque, empty query → non-empty intersection including a title without Bach/Vivaldi/Handel/Pachelbel.
- AE2. Early 20th century includes Debussy; Modern does not use that surname list.
- AE3. Default = Popular, no network. Adding Nocturne calls search and drops Popular as the list.
- AE4. Piano · Fugue · Modern empty → honest empty, not a failed scan.
- AE5. Type a non-Popular title with default Piano → live search, no instrument hard filter.
- AE6. Baroque on + typed query → search variants do not contain Bach/Vivaldi/Handel as injected tokens.

## Planning Contract

- KTD1. Membership table + INTERSECT. Bootstrap from Popular + extras until a category snapshot is `ok`.
- KTD2. No Category Walker scrape.
- KTD3. Instrument clause is category ∪ `(arr)`.
- KTD4. Delete `ERA_COMPOSER_SEEDS`.
- KTD5. Typed search does not require membership rows.
- KTD6. `filtersForTypedSearch` strips default-only Piano. Same rule on the server.

## Implementation Units

### U1–U5. Taxonomy, cache, browse, UI, tests

As previously specified: bind era categories; table + snapshots; browse from INTERSECT; panel chips/copy; rewrite seed-era tests.

### U6. Typed-search hygiene (same PR)

**Goal:** Import-any-piece path is not warped by default Piano or era surnames.

**Requirements:** R8, R11, R12, R13. AE5, AE6.

**Files:** `supabase/functions/_shared/searchFacetData.ts`; `src/features/imslp/ImslpSearchPanel.tsx`; `supabase/functions/imslp-search/index.ts`; `src/features/imslp/ImslpBrowser.test.tsx`; `tests/imslp/filters.test.ts`.

**Approach:**

1. `filtersForTypedSearch` drops `instrument` when it is default Piano and no other chip is on.
2. Client sends that object for `q.length >= 2`. Server applies the same strip before `hardFilterCategories`.
3. `facetTokens` does not read era surnames.

**Test scenarios:**

- Covers AE5. Typed “beethoven sonata” with default Piano calls search without `filters.instrument`.
- Covers AE6. `facetTokens({ era: 'baroque' })` is empty of Bach/Vivaldi/Handel.
- Violin selected + typed query still sends `instrument: 'violin'`.
