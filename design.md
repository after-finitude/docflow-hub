# Docflow Hub Design System

The interface is an operator workbench used throughout the day: compact, quiet, and information-first.

## Principles

- Application pages use a fixed top bar and full-width work area.
- The queue and execution log use dense tables; review uses a document/fields split.
- The login page uses one card in the left third of the viewport.
- Color communicates state, never decoration, and is always paired with text.
- Use hairline borders instead of decorative shadows or nested cards.
- Keep one primary action per context and show errors next to the failed action.

## Tokens

`apps/web/app/tokens.css` is the single source of color, type, spacing, geometry, motion, and layer values. Markup uses token names rather than inline color values.

- Display: Space Grotesk 500/600.
- Body: Inter 400/500.
- Technical values: JetBrains Mono 400/500.
- Spacing follows a 4px scale.
- Controls are 36px high and grow to 44px for coarse pointers.
- Motion is limited to transform and opacity and respects reduced-motion settings.

## Accessibility

- Body text meets WCAG AA contrast.
- Focus rings appear immediately and never animate.
- Status color is duplicated by a word or icon label.
- Keyboard controls use native elements and maintain visible focus.
- Long technical values wrap without stretching tables.

Extend these tokens and established components instead of creating page-specific visual systems.
