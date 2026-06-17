---
name: anti-slop
description: Generate deliberate, highly-opinionated, and functional UI designs.
---

## 1. LAYOUT & COMPOSITION RULES

- **PROHIBIT unnecessary container sprawl.** Do not wrap every element in a bordered card with a border radius. Use typography, negative space, and layout to separate content.
- **PROHIBIT the split heading/description header.** Do not place a section heading on the left and its description on the right side of the same line. Stack the heading and its supporting text vertically instead.

## 2. TYPOGRAPHY & HIERARCHY RULES

- **PROHIBIT the "Eyebrow" kicker.** Do not use the small, all-caps, colored pre-title text above section headings. Let primary titles breathe.
- **ENFORCE a strict subtitle limit.** Maximum of ONE subtitle per heading block. Force conciseness in hierarchy.

## 3. UI COMPONENTS & ELEMENTS

- **PROHIBIT decorative pills and badges.** Pills, badges, and status indicators must be tied to dynamic, actionable data (e.g., `Status: Active`, `14 Errors`). Never use them as decorative flair.
- **PROHIBIT unnecessarily numbered cards.** Never number cards (01, 02, 03) unless the content describes a strict, sequential process or chronological funnel.

## 4. TEXT DENSITY & METADATA RESTRAINT

The biggest slop tell is cramming the page full of tiny labels, captions, and pseudo-technical metadata to fake richness and "editorial" depth. Restraint is mandatory.

- **PROHIBIT decorative metadata / "data exhaust."** Do not scatter fake technical micro-labels to make a layout look detailed. This explicitly bans invented coordinates (`47.6062°N`), timestamps and dates, version/issue/volume tags (`VOL. 04`, `ISSUE 02`), edition names, reading times (`READING: 41 MIN`), page or item counts (`248 PAGES`), source counts (`LIVE · 11 SOURCES`), plate/figure/section indices (`PLATE 01`, `00 / SIGNATURE`), file paths, and similar ornamental annotations. Include such data ONLY when it is real, functional, and necessary for the user.
- **PROHIBIT all-caps monospace micro-label clutter.** Do not line headers, footers, corners, image edges, and section breaks with small all-caps or monospace tags. These are decoration masquerading as information.
- **ENFORCE a strict label budget.** Every label, caption, tag, and line of microcopy must earn its place by carrying real, necessary meaning. If removing a piece of text does not lose real information, remove it. Strongly prefer fewer, larger, meaningful elements over many tiny ones.
- **PROHIBIT redundant or obvious labeling.** Do not label things the user can already see (e.g., a `LOGO` tag on the logo, a `HERO` tag on the hero). Do not restate the same identity (name, edition, location) in multiple places.
- **ENFORCE generous quiet space over filler.** When space exists, let it breathe. Never fill empty regions with decorative labels, coordinates, or metadata just to occupy them.

## 5. VISUALS, ICONOGRAPHY & DATA

- **PROHIBIT Unicode emojis in UI design.** Emojis are not icons. Map all visual concepts to a defined, consistent SVG icon library (e.g., Lucide, Phosphor).
- **PROHIBIT scaling icons as graphics.** Icons are for utility (max `32px`). Do not scale a generic line icon to `128px` to serve as a hero illustration. If a graphic is needed, use custom abstract shapes, images, or UI snippets.
- **PROHIBIT generic gradient charts.** Charts must represent realistic data scales and grouping. Do not use sweeping linear gradients behind disconnected or unrelated metric call-outs.
- **PROHIBIT the Purple/Blue SaaS gradient.** Ban default linear gradients. Use solid brand colors, strict monochrome, or highly deliberate mesh gradients.
- **PROHIBIT heavy glassmorphism.** Do not use `backdrop-filter: blur()` unless the element is explicitly floating over a complex, moving, or highly-textured background.
- **PROHIBIT flat, muddy drop shadows.** Ban heavy, single-layer drop shadows. Require multi-layered, ultra-subtle shadows, or rely on hard, brutalist borders if the brand calls for it.

## 6. CONTENT & COPYWRITING (THE FORBIDDEN WORDS)

Do not use AI-generated filler copy. When generating placeholder text, headings, or feature descriptions, **STRICTLY BAN** the following words:

- Unleash / Unlock
- Supercharge
- Elevate
- Seamless / Seamlessly
- Leverage
- Dive In
- Tapestry
- Next-generation / Next-level

**PROHIBIT em dashes.** Never use em dashes (—) in headings or body text. Rewrite with commas, periods, or parentheses instead.

**ACTIONABLE COPY RULE:** Prioritize "Show, Don't Tell." Instead of an abstract icon and a paragraph explaining a feature, generate a snippet of the actual UI, realistic code block, or data table that demonstrates the feature.
