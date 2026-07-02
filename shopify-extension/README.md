# Mum Reminders — Shopify Checkout UI Extension

A Thank You / Order Status page extension that lets customers opt in to
Mum's Birthday, Christmas, and Mother's Day reminders right after checkout.

## What it does

On the Thank You page, the customer sees a card:

- Text field: Mum's birthday (DD/MM — year optional)
- Three toggles: Birthday reminder, Christmas reminder, Mother's Day reminder
- Save button

On save, the extension POSTs to your app's public endpoint
(`/api/public/hooks/save-reminders`) with the order's customer email +
the reminder data. Your backend upserts a `customers` row and pushes the
profile to Klaviyo.

## Local development (no impact on live store)

1. Create a **development store** in your Shopify Partner dashboard
   (Partners > Stores > Add store > Development store). It's free and
   sandboxed — nothing you do there touches your live store.
2. Install the Shopify CLI: `npm i -g @shopify/cli @shopify/app`
3. From this folder: `shopify app dev --store=<your-dev-store>.myshopify.com`
   The CLI tunnels a preview build into the dev store's checkout.
4. Place a test order on the dev store to see the extension render on
   the Thank You page.

## Deploying to production

Only after end-to-end testing on the dev store:

```
shopify app deploy
```

Then in the live store's Shopify admin: Settings > Checkout > Customize >
add the "Mum Reminders" block to the Thank You page.

## Files

- `shopify.app.toml` — app manifest
- `extensions/mum-reminders/shopify.extension.toml` — extension manifest
- `extensions/mum-reminders/src/Checkout.tsx` — UI code
- `extensions/mum-reminders/package.json` — extension deps

## Config

The extension reads the backend URL from the extension's settings
(configured per-store in the Shopify admin). Default points at the
Lovable preview URL for dev; switch to your production domain before
deploying to the live store.
