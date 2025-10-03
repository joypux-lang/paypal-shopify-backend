# PayPal ↔ Shopify Bridge (2025 defaults)

Endpoints:
- POST /api/paypal/client-token
- POST /api/paypal/create-order
- POST /api/paypal/capture
- POST /api/shopify/order-from-paypal

Defaults:
- SHOPIFY_STORE default: iptcy7-up
- SHOPIFY_API_VERSION default: 2025-10

Render:
- Build: npm install
- Start: npm start
- Env vars: set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / SHOPIFY_ADMIN_TOKEN / ALLOWED_ORIGIN
