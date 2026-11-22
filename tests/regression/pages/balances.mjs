// The Balances screen: the total, the "If you squared up" lines, and Recent.
export const balances = (page) => ({
  total: page.locator('#main .card.dark .hero'),
  counts: page.locator('#main .card.dark .lbl-dark.right'),
  transfers: page.locator('#main .card:has(> .lbl:text("If you squared up")) .kv'),
  recent: page.locator('#main .row-compact'),
  recentTitles: () => page.locator('#main .row-compact .grow > .strong').allInnerTexts(),
});
