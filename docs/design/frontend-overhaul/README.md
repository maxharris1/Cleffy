# Cleffy front-end overhaul — design reference

This folder is the specification for the site-wide front-end overhaul approved by Max on 2026-11-25
("I love this"). It lives on the branch `design/frontend-overhaul` only, as a reference; do not merge it
into `dev` and do not copy these files into a feature PR.

The goal is a one-to-one build of these screens in the real app. Where a number below and a
screenshot disagree, the HTML file for that screen wins: every value in it is an inline style.

## What is in here

| Path             | What it is                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `screens/*.png`  | One full-page screenshot per screen. Desktop at 1440 px wide (1×), phone at 390 × 844 (2×).         |
| `html/*.html`    | The same screen as standalone HTML. All styling is inline, so paddings, radii, sizes and colours can be read directly. Open it in a browser to inspect, or grep it. |
| `assets/*.png`   | The Für Elise artwork used in the screens. `fur-elise-opening.png` is the same file the app already ships as `public/marketing/fur-elise-opening.png`. The three page images are stand-ins for real score thumbnails and are not needed in the app. |

Get the files into a scratch folder without touching your working tree:

```sh
git fetch --depth 1 origin design/frontend-overhaul
mkdir -p /tmp/cleffy-design && git archive FETCH_HEAD docs/design/frontend-overhaul | tar -x -C /tmp/cleffy-design
# then read /tmp/cleffy-design/docs/design/frontend-overhaul/README.md
```

The interactive canvas (public, needs a real browser with JavaScript; a plain HTTP fetch returns an empty shell):
https://claude.ai/artifact/81wf3gDgViczqbZG4WcNPU — tab "Click-through (recommended)". One screen:
`https://claude.ai/artifact/81wf3gDgViczqbZG4WcNPU#artboard-Flow-Library` (swap the name). The tabs named
"Round 1 · …", "Navigation options" and "Students options" are superseded explorations. Ignore them.

The reference HTML loads Google Fonts for convenience. The app must not: its CSP is `font-src 'self'` and
it already self-hosts Bodoni Moda, Instrument Sans and Caveat (`src/index.css`).

## The idea in three lines

- **Ink is the frame.** The top bar of every signed-in screen, the viewer's header, the art half of every
  sign-in page, the 404, and the one chosen item in a set (the current plan). Never a block inside page content.
- **Paper is everything you read.** Page ground, titles, lists, dialogs. Lists are ruled with hairlines, not boxed.
  Where a panel is needed it is outlined paper. There are no white cards.
- **White is only what you write or draw on.** Score pages and thumbnails, form fields and small controls,
  the viewer's floating toolbar and round buttons, and the printed setup card.

This is the landing page's language (already on `dev`: `src/features/marketing/`), carried into the app.

## Tokens

Existing `@theme` tokens in `src/index.css` are reused where the value matches. New ones are marked **new**;
name them to fit the file's conventions.

| Role                                   | Value                         | Existing token             |
| -------------------------------------- | ----------------------------- | -------------------------- |
| Ink (frame, text)                      | `#1c1917`                     | `--color-ink`              |
| Paper (page ground, dialogs)           | `#f7f5ef`                     | `--color-paper`            |
| Deep paper (phone frame backdrop only) | `#edeae0`                     | `--color-paper-deep`       |
| Viewer desk                            | `#ebe8df`                     | **new**                    |
| White (score, fields, controls)        | `#ffffff`                     | —                          |
| Text, muted                            | `#57534e`                     | `--color-ink-muted`        |
| Text, soft (secondary on paper)        | `#44403c`                     | **new** (stone-700)        |
| Hairline between rows and sections     | `#e3dfd3`                     | **new** (opaque; `--color-line` is translucent) |
| Panel outline, chip outline            | `#d9d4c6`                     | **new**                    |
| Field border                           | `#cfc9bb`                     | **new**                    |
| Outline button border                  | `#bdb6a6`                     | **new**                    |
| Segmented-control trough               | `#e4dfd2`                     | **new**                    |
| Accent on paper (actions, links)       | `#4338ca`                     | `--color-accent`           |
| Accent tint (anything selected)        | `#e9e8fb`                     | **new** (opaque; do not use the 10% `--color-accent-soft` for these) |
| Accent on ink (filled button)          | `#4f46e5`                     | `--color-ink-cta`          |
| Wordmark rule on ink                   | `#818cf8`                     | `--color-ink-rule`         |
| Text on ink                            | `#f7f5ef`                     | `--color-paper`            |
| Text on ink, muted                     | `#d6d3d1`                     | **new** (stone-300)        |
| Text on ink, faint                     | `#a8a29e`                     | **new** (stone-400)        |
| Handwriting on ink, active-tab rule    | `#facc15`                     | `--color-ink-hand`         |
| Handwriting on paper                   | `#b91c1c`                     | red-700                    |
| Highlighter                            | `#fde047`                     | `--color-highlighter`      |
| Done / set up / synced / visible       | `#15803d` (`#4ade80` on ink)  | `--color-tick`             |
| Due / invited pill                     | text `#854d0e` on `#fef3c7`   | amber-800 on amber-100     |
| Teacher's pen, teacher avatar          | `#dc2626`                     | red-600                    |
| Student's pen                          | `#2563eb`                     | blue-600                   |
| Destructive text                       | `#b91c1c`                     | `--color-danger`           |
| Dialog scrim                           | `rgba(28,25,23,0.38)`         | `--color-scrim` is 0.45; keep the existing token |

Colour carries meaning, so do not swap these for decoration: indigo is action and selection, red is the
teacher, blue is the student, yellow is handwriting on ink and highlighter under dates, amber is due or
invited, green is done.

### Page background

Flat `#f7f5ef`. No gradient wash and no staff lines: `.paper-page` loses both background images, and
sign-in, join, 404 and error pages stop using `.landing-page`. Fine repeating lines render unevenly at any
browser zoom other than 100% and on fractionally scaled displays, which is why they are gone. The marketing
landing page (`/`) keeps `.landing-page` as it is; do not change the landing page in this work.

## Type

- **Titles:** Bodoni Moda, weight 600, `font-variation-settings: 'opsz' 10` (the low optical size keeps the
  hairlines thick; the landing page already does this in `landing.css`). `letter-spacing: -0.02em`,
  `line-height: 1.02`, `text-wrap: balance`. Page title 60 px; student home 64 px; dialog title 28 px;
  section heading 24–30 px; 404 title 116 px. On a phone the page title is 44–46 px.
- **Italic for the second thought:** "Your *pieces.*", "*Tacet.*", "Free to start. *Students never pay.*", and
  the piece name in the viewer header ("Beethoven — *Für Elise*").
- **Everything else:** Instrument Sans. Body 15 px / 1.5; page subtitle 17 px; small 13 px; `text-wrap: pretty`.
- **Eyebrow** above each page title and as field labels: 12 px, weight 600, `letter-spacing: 0.08em`,
  uppercase, colour `#57534e`.
- **Handwriting:** Caveat 700, 25–32 px, rotated −1° to −2°. At most one handwritten line per screen
  (the teacher's notes on the student's list count as content, not decoration).
- **Numbers** that line up (counts, prices, page numbers): `font-variant-numeric: tabular-nums`.

## Components

Exact markup for each is in the HTML files; these are the rules.

**Wordmark.** "Cleffy" in Bodoni 600, followed by a 2 px rule about as long as the cap height is tall
(width ≈ 0.95 × font size, gap ≈ 0.36 × font size). Ink text and `#4338ca` rule on paper; paper text and
`#818cf8` rule on ink. 28 px in the top bar, 30 px on sign-in pages, 26 px on a phone.

**Buttons.** Min height 44 px, padding `0 18px`, radius 12 px, 15 px / 600, icon 17 px with 8 px gap.
Small: padding `0 14px`, radius 10 px, 14 px.

| Kind        | Background    | Text      | Border                             | Shadow |
| ----------- | ------------- | --------- | ---------------------------------- | ------ |
| Primary     | `#4338ca`     | `#ffffff` | 1.5 px `#4338ca`                   | `inset 0 1px 0 rgba(255,255,255,0.16), 0 10px 20px -12px rgba(67,56,202,0.75)` |
| Outline     | transparent   | `#1c1917` | 1.5 px `#bdb6a6`                   | none |
| Ghost       | transparent   | `#44403c` | 1.5 px transparent                 | none |
| Destructive | transparent   | `#b91c1c` | 1.5 px transparent                 | none |
| Primary on ink | `#4f46e5`  | `#ffffff` | 1.5 px `#4f46e5`                   | `inset 0 1px 0 rgba(255,255,255,0.16), 0 10px 22px -12px rgba(79,70,229,0.95)` |
| Outline on ink | transparent | `#f7f5ef` | 1.5 px `rgba(247,245,239,0.42)`   | none |
| Ghost on ink | transparent  | `#d6d3d1` | 1.5 px transparent                 | none |

**Fields.** White, 48 px high, radius 12 px, 1.5 px `#cfc9bb` border, 16 px text, padding `0 14px`. Label is
an eyebrow 6 px above. Hint is 13 px muted, 6 px below. Search field: 46 px high with an 18 px icon at 14 px.

**Segmented control** (Recent / A–Z, grid / list, Edit / View, Can edit / View only, Monthly / Annual,
My scores / Student copies). Trough `#e4dfd2`, radius 11 px, 3 px padding. Chosen side: white key, radius
8 px, `box-shadow: 0 1px 2px rgba(28,25,23,0.22), 0 0 0 1px rgba(28,25,23,0.05)`, ink text, weight 600.
Other side: transparent, `#57534e`, weight 500. Key height 40 px (32 px small). Never a black fill.

**Chip.** 34 px high, pill, 13 px. Idle: transparent, 1 px `#d9d4c6`, text `#44403c`, weight 500. Chosen:
`#e9e8fb`, text `#4338ca`, border `rgba(67,56,202,0.4)`, weight 600.

**Pill / badge.** 22 px high, pill, 11 px / 600. Accent: `#4338ca` on `rgba(67,56,202,0.1)` (or `#e9e8fb`).
Neutral: `#44403c` on `rgba(28,25,23,0.06)`. Due / invited: `#854d0e` on `#fef3c7`. Done: `#15803d` on
`rgba(21,128,61,0.1)`, with a 13 px tick for "Set up".

**Checkbox and radio.** 20 px. Checked: `#4338ca` fill (checkbox, white tick) or `#4338ca` ring with a 10 px
dot (radio). A checked checkbox row gets `rgba(67,56,202,0.07)` and weight 600. A chosen radio card gets a
1.5 px `#4338ca` border and `#f6f5fe` fill.

**Presence chip.** Pill, 30 px high, 10 px coloured dot plus the person's display name, 13 px / 600.
On paper: transparent with a 1 px `#d9d4c6` ring. On ink: `rgba(247,245,239,0.1)` with a
`rgba(247,245,239,0.24)` ring and paper text.

**Highlighter.** `box-shadow: inset 0 -0.52em 0 #fde047` on an inline span. Used under dates
("next due Thu, Nov 26") and one phrase on the student home. Not a gradient.

**Ruled list.** The default container. Rows separated by a 1 px `#e3dfd3` top border, one closing bottom
border on the list, no box, 4 px side padding. Column labels are eyebrows above the first row.

**Outlined panel.** Only where a group must read as one object inside a dialog (the link row in Share, a
note in Practice notes, the new-note box): transparent, 1 px `#d9d4c6`, radius 16 px (14 px for small rows).

**Dialog.** Paper `#f7f5ef`, radius 22 px, padding 28 px, shadow
`0 40px 90px -30px rgba(28,25,23,0.6), 0 0 0 1px rgba(28,25,23,0.08)`. Title in Bodoni 28 px. A 44 px close
button top right. Keep the existing dialog behaviour (focus trap, stacking, motion).

## Layout

**Teacher top bar** (`Flow-Library`). Ink, full width, content max-width 1360 px with 40 px gutters, 64 px
tall. Left to right: wordmark (links to the library), then Library · Students · Find a score, then on the
right "Upload score" (primary on ink, upload icon) and the avatar with a chevron. Tabs are 15 px; idle
`#d6d3d1` weight 500; current tab paper text, weight 600, with a 2 px `#facc15` underline on the bar's
bottom edge. The avatar menu keeps its current contents.

**Page head** (every signed-in page). On paper, inside the page's max width: 48 px top padding, eyebrow,
title, 14 px gap, subtitle at 17 px muted, 32 px bottom padding, then one `#e3dfd3` hairline across the
content width. A page-level action (for example "Add student", "Sign out") sits at the right, aligned to
the bottom of the head. Content begins 32 px under the hairline.

| Page          | Eyebrow                                | Title            | Max width |
| ------------- | -------------------------------------- | ---------------- | --------- |
| Library       | `<display name> · <n> scores`          | Library          | 1360 px   |
| Find a score  | `Public domain · free to add`          | Find a score     | 1360 px   |
| Students      | `<n> students · <m> still to set up`   | Students         | 1180 px   |
| One student   | back link "← Students" above the head  | the student's name, with an 80 px avatar | 1280 px |
| Account       | `<display name> · <plan> plan`         | Account          | 1180 px   |
| Student home  | `<student first name> · with <teacher display name>` | Your *pieces.* | 880 px |

**Phone** (`Flow-Phone-Library`, `Flow-Phone-Viewer`, `Flow-Phone-Pieces`). Ink header with the wordmark,
a 44 px upload button and the avatar. The three destinations move to a tab bar fixed to the bottom of the
screen: paper at 97% opacity, a `#e3dfd3` top hairline, icon above an 11 px label, the current one in ink
with a 2 px `#4338ca` rule on its top edge; it must sit above the home indicator (`--safe-bottom`). The
score grid is two columns.

**Sign-in pages** (`Flow-Login` and the rest of that row). Two halves that wrap on a narrow screen. Left:
paper, padding `36px 56px 32px`, wordmark top left, the form centred vertically in a 400 px column, the legal
links along the bottom. Right: ink, padding `64px 56px`, content centred. On teacher pages the ink half
holds the marked Für Elise opening on a white sheet (radius 8 px, rotated −1.4°, shadow
`0 40px 80px -30px rgba(0,0,0,0.8)`), then the "Ms. Davis" and "Leo" presence chips, one yellow handwritten
line, and one sentence in `#d6d3d1`. On student pages it holds the setup card (rotated −1.6°) and the yellow
line "hand this over at the lesson". On a phone the ink half sits below the form or is dropped; the form
must stay first.

**Viewer** (`Flow-Viewer`, `Flow-Viewer-Student`). Ink header, 64 px: back arrow, title in Bodoni 22 px with
the piece name in italic, then on the right the presence chips, "Synced" with a `#4ade80` dot, Full screen,
History, Notes, Export as text buttons in `#d6d3d1`, and Share as a primary-on-ink button. Desk `#ebe8df`.
The page is white with `box-shadow: 0 0 0 1px rgba(28,25,23,0.08), 0 30px 60px -30px rgba(28,25,23,0.45)`.
Floating toolbar: white, radius 18 px, 16 px under the header, centred. Tool buttons 54 × 50 px with a
19 px icon over an 11 px label; the tool in hand is `#e9e8fb` with `#4338ca` text. Colour dots 22 px, the
current one ringed (`0 0 0 2px #fff, 0 0 0 4px #1c1917`). Page stepper bottom left and layout / zoom buttons
bottom right are white 46 px circles.

## Screens

Files are `screens/<name>.png` and `html/<name>.html`. "Ticket" is the build ticket that owns the screen.

| Name                  | Route or surface                 | Main files today                                           | Ticket |
| --------------------- | -------------------------------- | ---------------------------------------------------------- | ------ |
| `Flow-Library`        | `/library`                       | `src/features/library/LibraryShell.tsx`, `LibraryPage.tsx`, `ScoreCard.tsx` | Foundations and shell; Library |
| `Flow-Phone-Library`  | `/library` on a phone            | same                                                       | Foundations and shell; Library |
| `Flow-Find`           | `/search`                        | `src/features/library/SearchPage.tsx`, `src/features/imslp/` | Library |
| `Flow-Login`          | `/login`                         | `src/ui/BrandShell.tsx`, `src/features/auth/LoginPage.tsx`  | Sign-in |
| `Flow-Register`, `Flow-Register-2` | `/register`         | `src/features/auth/RegisterPage.tsx`, `AgeScreen.tsx`       | Sign-in |
| `Flow-Forgot`         | `/forgot-password`, `/update-password` | `src/features/auth/ForgotPasswordPage.tsx`, `UpdatePasswordPage.tsx` | Sign-in |
| `Flow-Student`        | `/student`                       | `src/features/student/StudentLoginPage.tsx`                 | Sign-in |
| `Flow-Claim`, `Flow-Claim-2` | `/student/claim`          | `src/features/student/StudentClaimPage.tsx`                 | Sign-in |
| `Flow-Join`           | `/join/:token`, `/invite`, `/s`  | `src/features/share/JoinPage.tsx`, `InvitePage.tsx`, `ShareLinkPage.tsx` | Sign-in |
| `Flow-Pieces`, `Flow-Phone-Pieces` | `/assignments`      | `src/features/student/AssignmentsPage.tsx`                  | Student home and dead ends |
| `Flow-NotFound`       | any unknown route                | `src/features/marketing/NotFoundPage.tsx`                   | Student home and dead ends |
| `Flow-Viewer`, `Flow-Viewer-Student`, `Flow-Phone-Viewer` | `/doc/:documentId` | `src/features/viewer/ViewerHeader.tsx`, `toolbar/Toolbar.tsx`, `presence/` | Viewer chrome |
| `Flow-Share`          | Share dialog                     | `src/features/share/ShareDialog.tsx`                        | Viewer chrome |
| `Flow-Notes`          | Practice notes                   | `src/features/notes/NotesPanel.tsx`                         | Viewer chrome |
| `Flow-History`        | Lesson history                   | `src/features/viewer/history/`                              | Viewer chrome |
| `Flow-Toolbar`        | the toolbar under each kind of input | `src/features/viewer/toolbar/Toolbar.tsx`, `ink/InkController.ts` | Toolbar by input |
| `Flow-Students`       | `/students`                      | `src/features/roster/RosterPage.tsx`                        | Students |
| `Flow-Student-Detail` | `/students/:studentId` (new)     | new page in `src/features/roster/`                          | Students |
| `Flow-Add-Student`    | Add a student dialog             | `src/features/roster/RosterPage.tsx`, `AgeAttestationFields.tsx` | Students |
| `Flow-Setup-Card`     | Setup card dialog and print      | `src/features/roster/StudentCodeCard.tsx`, `.css`           | Students |
| `Flow-Assign`         | Assign to students dialog        | `src/features/roster/AssignDialog.tsx`                      | Students |
| `Flow-Account`        | `/account`                       | `src/features/account/AccountPage.tsx`                      | Account |
| `Flow-Plans`          | Plans dialog                     | `src/features/billing/PricingDialog.tsx`                    | Plans dialog |
| `Flow-Library-Leo`, `Flow-Viewer-Original`, `Flow-Viewer-Switch` | student copies | — | Student copies (not started; see below) |

## In the screens but not part of the restyle

The screens show the finished product, including a feature that is not built yet. Until its own tickets
land, leave these out and keep today's behaviour in their place:

- **Per-student copies.** The "My scores | Student copies" filter and student picker, the "2 copies" avatars
  under a tile, the "Leo's copy" label on a thumbnail, the "Leo's copy ▾" pill and switcher in the viewer
  header, the "What do they get? A copy each / One shared copy" block and the "Makes 2 copies" line in the
  assign dialog, the "His own copy" / "Shared with Chloe" pills and the sentence "Each one is his copy.
  Your original stays clean." on the student page, and "their own copy of every score you assign" in the
  Students subtitle. Use today's subtitle wording there.
- **"Write a note" on the student page.** Notes are written from a score. Leave the button out.
- **Sample data.** Names, dates, tags ("Lesson", "Recital"), counts and the plan are examples. Render real data.
  If a field has no data (no due date, no note, no username), leave its slot empty; do not print a placeholder.

## Rules that still apply

From `factory.md` and the project's standing rules:

- Never surface play-along, the fingering tool, AI-generated marks or the Founding offer. The toolbar's
  flagged fingering tool stays exactly as gated as it is today.
- No analytics, pixels or third-party requests. No new font hosts; fonts stay self-hosted.
- Every price shows its tax treatment as it does today. Do not change prices, plan names or plan copy.
- Do not change legal text, consent flows, age checks, or any copy that states a rule (minimum age,
  refunds, deletion). Restyle around it.
- Keep every existing behaviour, route, keyboard shortcut, focus order and `aria` label unless a ticket
  says otherwise. Touch targets stay at least 44 px on coarse pointers (`hit-44`).
- Respect `prefers-reduced-motion` and the motion tokens already in `src/index.css`. This work adds no new motion.
- Check every touched screen with the `ui-check` skill at desktop, tablet and phone widths before asking for review.
