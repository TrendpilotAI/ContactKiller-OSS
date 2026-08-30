---
name: ContactKiller
description: A tactile forensic editorial system for provenance-first contact reconciliation.
colors:
  ink: "#0c0d0e"
  ink-soft: "#151617"
  ink-raised: "#1d1b18"
  paper: "#d9c6af"
  paper-pale: "#eee0cc"
  paper-deep: "#b2a28d"
  vermilion: "#a93a26"
  vermilion-bright: "#e2462d"
  cobalt: "#0b3ac5"
  cobalt-bright: "#174fe8"
  brass: "#5c4831"
  brass-light: "#b2a28d"
  verified: "#9acd32"
typography:
  display:
    fontFamily: 'Georgia, "Times New Roman", Times, serif'
    fontSize: "clamp(3.35rem, 5.4vw, 6.7rem)"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "-0.04em"
  body:
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(1rem, 1.35vw, 1.16rem)"
    fontWeight: 400
    lineHeight: 1.75
  label:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: "0.69rem"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "0.13em"
rounded:
  mechanical: "3px"
  indicator: "50%"
spacing:
  page-inline: "clamp(1.25rem, 4vw, 4.5rem)"
  section-block: "clamp(5rem, 10vw, 10rem)"
  control-gap: "0.85rem"
---

# ContactKiller Design System

## Overview

The visual north star is **The Human Switchboard**: a tactile reconciliation bench where source drawers, paper evidence, routed cables, and a visibly locked write gate make data lineage physical. It should feel forensic but humane—precise, candid, and lightly irreverent—not like a generic SaaS dashboard. The narrative always moves from conflicting sources, through conservative identity resolution, to a proposed write that remains human-gated.

The approved reference is `.impeccable/mocks/reconciliation-bench.png`; the exact hero reproduction is `.impeccable/review/hero-repro.png`. Shipping views are represented by `.impeccable/review/desktop.png` and `.impeccable/review/mobile.png`.

Approved public assets:

- `website/public/switchboard-machine.webp` is a generated, deliberately textless material layer. Its prompt and creation timestamp are recorded in the adjacent JSON sidecar; semantic labels and synthetic data must remain HTML overlays.
- `website/public/og.svg` is the editable, deterministic social source. `og.png` is its 1200×630 `librsvg` render; the sidecar records the command, declares it non-AI-generated, and confirms it contains no real contact data.
- `website/public/icon.svg` is the canonical CK mark and uses only approved palette colors.

## Colors

| Role | Token | Use |
| --- | --- | --- |
| Field | `ink`, `ink-soft`, `ink-raised` | Near-black page, machinery, and raised instrument surfaces |
| Paper | `paper`, `paper-pale`, `paper-deep` | Archival sheets, evidence slips, primary text, and muted paper states |
| Conflict | `vermilion`, `vermilion-bright` | Conflict cables, warnings, and the single editorial headline emphasis |
| Action | `cobalt`, `cobalt-bright` | Primary actions only; never decoration or ambient chrome |
| Hardware | `brass`, `brass-light` | Rules, fittings, borders, labels, and secondary text |
| Verified | `verified` | Sparse positive confirmation; never the default success wash |

Keep surfaces matte and tonal. Do not introduce gradients, neon, glass effects, or a second accent family. Status must never rely on color alone: pair every hue with a text label, symbol, or structural state.

## Typography

Use the display serif for the brand, large editorial headlines, and high-level section statements. Headlines are intentionally oversized, tightly tracked, sentence case, and allowed to break dramatically. Use the sans stack for readable explanatory copy. Use the mono stack for navigation, labels, statuses, metadata, controls, and process language; labels are generally uppercase at 11–13px with generous tracking.

Do not render meaningful text into raster assets. Preserve real heading order, readable line lengths, and text scaling. The vermilion headline treatment is emphasis, not a separate type style.

## Layout

Use `--page-inline` for shared horizontal alignment and generous section spacing. Desktop hero composition is approximately 40% copy and 60% machinery, with the copy read first and the machine telling the same source → identity → locked-write story. Major sections alternate near-black instrument fields, warm paper, and one vermilion architecture field; brass rules maintain continuity.

Content grids may become stacked ledgers, but should not become interchangeable rounded cards. At tablet width, multi-column introductions, process rows, status boards, and ecosystem grids collapse to one column. At 680px and below, navigation reduces to the brand plus GitHub action, CTAs become full width, copy precedes a simplified vertical evidence machine, and all content must remain free of horizontal overflow.

## Elevation & Depth

Depth comes from material contrast: matte steel, warm paper, aged brass, woven cable, inset borders, and restrained shadows. The hero machine owns most of the photoreal depth. Semantic panels stay comparatively flat; a contribution docket may use one soft paper shadow, and mechanical controls may use subtle inset shading. Avoid generic floating-card shadows and decorative blur.

## Shapes

The system is square and mechanical. Use 1px brass rules, 2–4px routed cables, and 2–4px corner radii (`3px` by default). Circles are reserved for bolts, status lamps, and compact indicators. Do not use pill containers or large friendly radii.

## Components

- **Primary action:** cobalt fill, white mono label, minimum 3.35rem height, 3px radius. Hover changes to cobalt-bright and lifts 2px over 160ms.
- **Secondary action:** transparent or ink-soft surface with a brass border and paper-pale mono label; it may lift by the same 2px, but must never compete with the primary action.
- **Reconciliation machine:** a textless raster material layer plus semantic source records, evidence slips, synthetic identity docket, and locked provider-write gate. Preserve the left-to-right topology and the visibly gated final action.
- **Ledgers and dockets:** use rules, labels, numbering, and material color to establish hierarchy. Prefer structured rows over standalone cards.
- **Status indicators:** pair a small lamp or color edge with explicit copy such as conflict, partial, verified, proposed, or locked.
- **Motion:** keep movement brief and mechanical. The only ambient effect is a restrained 2.4s signal pulse, enabled only when reduced motion is not requested. All hover transitions are short; reduced-motion mode removes animation, transition duration, and smooth scrolling.

## Do’s and Don’ts

### Do

- Preserve the evidence-first sequence: observe, normalize, propose, review, then write.
- Keep copy candid about experimental status, uncertainty, and human approval boundaries.
- Use only synthetic fixtures in demonstrations; “Maya Chen” is the approved current example.
- Meet WCAG 2.2 AA contrast, retain the skip link, visible keyboard focus (3px outline plus halo), semantic landmarks, and comfortably sized controls.
- Keep raster imagery textless and provenance sidecars adjacent to generated or rendered assets.
- Test both reviewed layouts: desktop hierarchy and the simplified, copy-first mobile flow.

### Don’t

- Do not imply that a proposed change was applied, or add decorative/unverified metrics.
- Do not introduce real contact data, provider branding, unsupported logos, people, or faces into demo assets.
- Do not use gradients, glassmorphism, neon glow, pill-heavy UI, soft SaaS card grids, or gratuitous animation.
- Do not use cobalt outside primary actions or overuse vermilion/verified lime.
- Do not flatten provenance into a generic “sync” metaphor; this product is reconciliation, not synchronization.
