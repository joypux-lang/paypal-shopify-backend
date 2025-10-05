// server.js (CORS for glysi + laicea + Shopify test)
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// ====== CORS setup ======
const ALLOWED_ORIGINS = [
  "https://www.glysi.com",
  "https://glysi.com",
  "https://www.laicea.com",
  "https://laicea.com",
  "https://6b0a70-66.myshopify.com", // Shopify store domain for testing
  process.env.ALLOWED_ORIGIN // optional override from .env
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes("*")) {
      return callback(null, true);
    }
    console.warn(`🚫 CORS blocked for origin: ${origin}`);
    return callback(new Error("CORS not allowed for this origin."));
  }
}));

// ===== Env =====
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = "live",
  SHOPIFY_STORE = "iptcy7-up",
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = "2025-10"
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET)
  console.warn("⚠️ Missing PayPal credentials");
if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN)
  console.warn("⚠️ Missing Shopify credentials");

const PP_BASE =
  PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

const SHOP_ADMIN = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// ==== Helpers ====
async function paypalAccessToken() {
  const res = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(`PayPal OAuth failed: ${res.status} ${JSON.stringify(data)}`);
  return data.access_token;
}

async function shopifyGraphQL(query, variables = {}) {
  const r = await fetch(SHOP_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (!r.ok || j.errors)
    throw new Error("Shopify GraphQL error: " + JSON.stringify(j.errors || j));
  return j.data;
}

const toVariantGID = (id) => `gid://shopify/ProductVariant/${id}`;

// ==== PayPal: Client Token ====
app.post("/api/paypal/client-token", async (_req, res) => {
  try {
    const token = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v1/identity/generate-token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    const j = await r.json();
    if (!r.ok || !j?.client_token)
      return res.status(400).json({ error: "Failed to generate client token", details: j });
    res.json({ ok: true, client_token: j.client_token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==== PayPal: Create Order ====
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { value, currency = "USD" } = req.body || {};
    if (!value) return res.status(400).json({ error: "Missing amount value" });

    const token = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{ amount: { currency_code: currency, value } }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "PayPal create order failed", details: j });
    res.json({ ok: true, orderID: j.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==== PayPal: Capture ====
app.post("/api/paypal/capture", async (req, res) => {
  try {
    const { paypalOrderId } = req.body || {};
    if (!paypalOrderId) return res.status(400).json({ error: "Missing paypalOrderId" });

    const token = await paypalAccessToken();
    const capRes = await fetch(`${PP_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    const cap = await capRes.json();
    if (!capRes.ok) return res.status(400).json({ error: "PayPal capture failed", details: cap });

    const status =
      cap?.status || cap?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (status !== "COMPLETED")
      return res.status(400).json({ error: `Unexpected PayPal status: ${status || "unknown"}`, details: cap });

    const pu = cap?.purchase_units?.[0] || {};
    const ship = pu?.shipping?.address || {};
    const name = pu?.shipping?.name?.full_name || "";
    const payer = cap?.payer || {};
    const [given_name, ...rest] = (
      name ||
      `${payer?.name?.given_name || ""} ${payer?.name?.surname || ""}`
    )
      .trim()
      .split(" ");
    const surname = rest.join(" ").trim();

    const address = {
      firstName: given_name || payer?.name?.given_name || "",
      lastName: surname || payer?.name?.surname || "",
      address1: ship?.address_line_1 || "",
      city: ship?.admin_area_2 || "",
      zip: ship?.postal_code || "",
      country: ship?.country_code || "",
      phone: "",
      email: payer?.email_address || ""
    };

    const captureId =
      pu?.payments?.captures?.[0]?.id ||
      pu?.payments?.authorizations?.[0]?.id ||
      cap?.id;

    res.json({ ok: true, captureId, address, raw: cap });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==== Shopify Draft → Complete ====
app.post("/api/shopify/order-from-paypal", async (req, res) => {
  try {
    const b = req.body || {};
    const errs = [];
    if (!Array.isArray(b.line_items) || b.line_items.length === 0)
      errs.push("line_items is required");
    const A = b.address || {};
    ["firstName", "lastName", "address1", "city", "zip", "country"].forEach((k) => {
      if (!A[k]) errs.push(`address.${k} is required`);
    });
    if (!b.shipping_label) errs.push("shipping_label is required");
    if (b.shipping_price == null) errs.push("shipping_price is required");
    if (errs.length)
      return res.status(400).json({ error: "Invalid payload", details: errs });

    const draftOrderCreate = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id }
          userErrors { field message }
        }
      }
    `;
    const draftInput = {
      email: A.email || undefined,
      billingAddress: {
        firstName: A.firstName,
        lastName: A.lastName,
        address1: A.address1,
        city: A.city,
        zip: A.zip,
        country: A.country,
        phone: A.phone || null
      },
      shippingAddress: {
        firstName: A.firstName,
        lastName: A.lastName,
        address1: A.address1,
        city: A.city,
        zip: A.zip,
        country: A.country,
        phone: A.phone || null
      },
      lineItems: b.line_items.map((li) => ({
        variantId: toVariantGID(li.variant_id),
        quantity: parseInt(li.quantity, 10),
        price: li.price ? li.price.toString() : null
      })),
      shippingLine:
        b.shipping_price !== "" && b.shipping_price != null
          ? { title: b.shipping_label || "Shipping", price: b.shipping_price.toString() }
          : null,
      note: `PayPal order: ${b.paypalOrderId || ""} | capture: ${b.paypalCaptureId || ""}`.trim()
    };
    console.log("📦 Draft input =>", JSON.stringify(draftInput, null, 2));

    const d1 = await shopifyGraphQL(draftOrderCreate, { input: draftInput });
    console.log("🧾 Shopify response =>", JSON.stringify(d1, null, 2));

    const ue1 = d1?.draftOrderCreate?.userErrors || [];
    if (ue1.length)
      return res.status(400).json({ error: "Shopify user errors", details: ue1 });
    const draftId = d1?.draftOrderCreate?.draftOrder?.id;
    if (!draftId)
      return res.status(400).json({ error: "Failed to create draft order", details: d1 });

    const draftOrderComplete = `
      mutation draftOrderComplete($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder { id order { id name } }
          userErrors { field message }
        }
      }
    `;
    const d2 = await shopifyGraphQL(draftOrderComplete, { id: draftId });
    const ue2 = d2?.draftOrderComplete?.userErrors || [];
    if (ue2.length)
      return res.status(400).json({ error: "Shopify user errors", details: ue2 });
    const orderNode = d2?.draftOrderComplete?.draftOrder?.order;
    if (!orderNode?.id)
      return res.status(400).json({ error: "Unable to complete draft order", details: d2 });
    res.json({ ok: true, order: orderNode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API listening on :${PORT}`));
