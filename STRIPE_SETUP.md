# Stripe setup for SilentGPT

SilentGPT now creates Stripe Checkout subscription sessions for monthly and annual plans, verifies the paid subscription after Checkout redirects back with the session ID, restores existing subscriptions by email, and opens Stripe Billing Portal for cancellation/payment-method management.

## 1. Create Stripe products and prices

1. Open the Stripe Dashboard in **test mode**.
2. Create a product such as `SilentGPT Pro`.
3. Add two recurring prices:
   - Monthly price, for example `$14.99 / month`.
   - Annual price, for example `$143.90 / year`.
4. Copy each `price_...` ID.

## 2. Configure environment variables

Copy `.env.example` to your own local environment file or CI/build secrets and fill in real values:

```bash
export SILENTGPT_STRIPE_SECRET_KEY=sk_test_your_key_here
export SILENTGPT_STRIPE_MONTHLY_PRICE_ID=price_your_monthly_price_id
export SILENTGPT_STRIPE_ANNUAL_PRICE_ID=price_your_annual_price_id
export SILENTGPT_STRIPE_SUCCESS_URL='https://trysilentgpt.net/checkout/success?session_id={CHECKOUT_SESSION_ID}'
export SILENTGPT_STRIPE_CANCEL_URL='https://trysilentgpt.net/checkout/cancel'
export SILENTGPT_STRIPE_BILLING_PORTAL_RETURN_URL='https://trysilentgpt.net/account'
```

Then start or package the app from that same shell/CI job.

## 3. Configure redirect pages

Stripe Checkout requires absolute success and cancel URLs. Host lightweight pages at:

- `/checkout/success` — show a success message such as "Payment complete. Return to SilentGPT." Keep the `session_id` query parameter intact.
- `/checkout/cancel` — show a cancellation message such as "Checkout cancelled. You can return to SilentGPT and try again."

The Electron checkout popup watches these URLs and activates the app when the success URL includes `session_id={CHECKOUT_SESSION_ID}`.

## 4. Enable Billing Portal

In Stripe Dashboard, enable **Billing Portal** and configure:

- Payment method updates.
- Subscription cancellation.
- Invoice history.
- Return URL matching `SILENTGPT_STRIPE_BILLING_PORTAL_RETURN_URL`.

## 5. Test before going live

1. Use test-mode API keys and test-mode `price_...` IDs.
2. Start the app with the environment variables set.
3. Click **Subscribe with Stripe** and use Stripe test card `4242 4242 4242 4242` with any future expiry/CVC.
4. Confirm the app unlocks after the Checkout success redirect.
5. Open **Settings → Subscription → Manage Billing** and confirm the portal opens.
6. Test cancellation and reactivation.
7. Test **Restore Subscription** using the same customer email.

## 6. Go live safely

1. Switch Stripe Dashboard to **live mode**.
2. Create live-mode monthly and annual recurring prices.
3. Replace the test secret key and price IDs with live values in your release environment.
4. Package the app from a shell/CI job that has the live environment variables.
5. Never commit or paste live secret keys into source code.

## Production security note

This Electron app can create Checkout Sessions when `SILENTGPT_STRIPE_SECRET_KEY` is available at runtime/build time, but a desktop bundle is not a perfect place for a Stripe secret. The most secure production architecture is to move Checkout Session creation, subscription lookup, and Billing Portal session creation to your own HTTPS backend, then have the Electron app call that backend. If you ship with a local Stripe key, use the least-privileged restricted key Stripe allows for the API calls you need and rotate it if it is exposed.
