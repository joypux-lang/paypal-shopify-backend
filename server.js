// server.js (Final - PayPal → Shopify, with items and shipping)
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";

const app = express();
app.use(helmet());
app.use(express.json({ limit: "2mb" }));

// CORS
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN === "*" ? true : [ALLOWED_ORIGIN] }));

// ENV
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = "live",
  SHOPIFY_STORE,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = "2025-10"
} = process.env;

if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN) console.warn("⚠️ Missing Shopify credentials");
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) console.warn("⚠️ Missing PayPal credentials");

const PP_BASE = PAYPAL_ENV === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
const SHOP_ADMIN = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function paypalAccessToken() {
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal OAuth failed: ${res.status} ${JSON.stringify(data)}`);
  return data.access_token;
}
async function shopifyGraphQL(query, variables = {}) {
  const r = await fetch(SHOP_ADMIN, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors) throw new Error("Shopify GraphQL error: " + JSON.stringify(j.errors || j));
  return j.data;
}
const toVariantGID = (id) => `gid://shopify/ProductVariant/${id}`;

// Create PayPal order with items
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { items = [], total, currency = "USD", shipping = {} } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Missing items" });

    const itemsTotal = items.reduce((sum, i) => sum + Number(i.price) * Number(i.quantity), 0);
    const shipVal = Number(shipping.price || 0);
    const grandTotal = Number(total || (itemsTotal + shipVal));

    const token = await paypalAccessToken();

    const ppItems = items.map(i => ({
      name: i.title || "Product",
      quantity: String(i.quantity),
      unit_amount: { currency_code: currency, value: Number(i.price).toFixed(2) }
    }));

    const body = {
      intent: "CAPTURE",
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: grandTotal.toFixed(2),
          breakdown: {
            item_total: { currency_code: currency, value: (itemsTotal).toFixed(2) },
            shipping:   { currency_code: currency, value: (shipVal).toFixed(2) }
          }
        },
        items: ppItems
      }]
    };

    const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "PayPal create failed", details: j });

    res.json({ ok: true, orderID: j.id });
  } catch (e) {
    console.error("❌ PayPal Create Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Capture PayPal
app.post("/api/paypal/capture", async (req, res) => {
  try {
    const { paypalOrderId } = req.body || {};
    if (!paypalOrderId) return res.status(400).json({ error: "Missing paypalOrderId" });

    const token = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    const j = await r.json();
    if (!r.ok) return res.status(400).json({ error: "PayPal capture failed", details: j });

    const pu = j?.purchase_units?.[0] || {};
    const payer = j?.payer || {};
    const addr = pu?.shipping?.address || {};

    const address = {
      firstName: payer?.name?.given_name || "",
      lastName:  payer?.name?.surname || "",
      address1:  addr?.address_line_1 || "",
      city:      addr?.admin_area_2 || "",
      zip:       addr?.postal_code || "",
      country:   addr?.country_code || "",
      email:     payer?.email_address || "",
      phone:     ""
    };

    const captureId = pu?.payments?.captures?.[0]?.id || j?.id;
    res.json({ ok: true, captureId, address, raw: j });
  } catch (e) {
    console.error("❌ PayPal Capture Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Create Shopify order
app.post("/api/shopify/order-from-paypal", async (req, res) => {
  try {
    const { items = [], address = {}, shipping = {}, paypalOrderId, paypalCaptureId } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Missing line items" });

    const draftOrderCreate = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }`;

    const draftInput = {
      email: address.email || undefined,
      billingAddress: address,
      shippingAddress: address,
      lineItems: items.map(i => ({ variantId: toVariantGID(i.variant_id), quantity: parseInt(i.quantity,10) })),
      shippingLine: (shipping && shipping.price && shipping.price !== "0.00")
        ? { title: shipping.label || "Shipping", price: String(shipping.price) }
        : null,
      note: `PayPal order ${paypalOrderId || ""} | capture ${paypalCaptureId || ""}`.trim()
    };

    console.log("📦 Shopify Input:", JSON.stringify(draftInput, null, 2));
    const d1 = await shopifyGraphQL(draftOrderCreate, { input: draftInput });
    const errs = d1?.draftOrderCreate?.userErrors || [];
    if (errs.length) return res.status(400).json({ error: "Shopify error", details: errs });

    const draftId = d1?.draftOrderCreate?.draftOrder?.id;
    if (!draftId) return res.status(400).json({ error: "No draft order returned" });

    const draftOrderComplete = `
      mutation draftOrderComplete($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }`;
    const d2 = await shopifyGraphQL(draftOrderComplete, { id: draftId });
    const errs2 = d2?.draftOrderComplete?.userErrors || [];
    if (errs2.length) return res.status(400).json({ error: "Shopify complete error", details: errs2 });

    const orderNode = d2?.draftOrderComplete?.draftOrder?.order;
    res.json({ ok: true, order: orderNode });
  } catch (e) {
    console.error("❌ Shopify Order Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API listening on :${PORT}`));
