// server.js — Final
import express from "express";
import cors from "cors";
import helmet from "helmet";
import fetch from "node-fetch";

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// CORS
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN === "*" ? true : [ALLOWED_ORIGIN] }));

// ===== Env =====
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_ENV = "live",
  SHOPIFY_STORE,               // مثل: "yourstore"
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_API_VERSION = "2025-10",
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn("⚠️ Missing PayPal credentials");
}
if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN) {
  console.warn("⚠️ Missing Shopify credentials");
}

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
        Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString(
          "base64"
        ),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
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
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (!r.ok || j.errors)
    throw new Error("Shopify GraphQL error: " + JSON.stringify(j.errors || j));
  return j.data;
}

const toVariantGID = (id) => `gid://shopify/ProductVariant/${id}`;

// ==== PayPal Client Token ====
app.post("/api/paypal/client-token", async (_req, res) => {
  try {
    const token = await paypalAccessToken();
    const r = await fetch(`${PP_BASE}/v1/identity/generate-token`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const j = await r.json();
    if (!r.ok || !j?.client_token) {
      return res
        .status(400)
        .json({ error: "Failed to generate client token", details: j });
    }
    res.json({ ok: true, client_token: j.client_token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==== PayPal Create Order (optional if تستخدم actions.order.create في الواجهة) ====
app.post('/api/shopify/order-from-paypal', async (req, res) => {
  try {
    const {
      paypalOrderId,
      paypalCaptureId,
      address,
      shipping_label,
      shipping_price,
      line_items
    } = req.body;

    const draft = await shopify.draftOrder.create({
      line_items: line_items.map(li => ({
        variant_id: li.variant_id,
        quantity: li.quantity,
        ...(li.price ? { price: parseFloat(li.price) } : {}) // ✅ أهم سطر
      })),
      shipping_line: {
        title: shipping_label,
        price: parseFloat(shipping_price)
      },
      billing_address: address,
      shipping_address: address,
      tags: [`paypal:${paypalOrderId}`, `capture:${paypalCaptureId}`]
    });

    await shopify.draftOrder.complete(draft.id);

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Order creation failed' });
  }
});


// ==== PayPal Capture ====
app.post("/api/paypal/capture", async (req, res) => {
  try {
    const { paypalOrderId } = req.body || {};
    if (!paypalOrderId)
      return res.status(400).json({ error: "Missing paypalOrderId" });

    const token = await paypalAccessToken();
    const capRes = await fetch(
      `${PP_BASE}/v2/checkout/orders/${paypalOrderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );
    const cap = await capRes.json();
    if (!capRes.ok)
      return res.status(400).json({ error: "PayPal capture failed", details: cap });

    const status =
      cap?.status ||
      cap?.purchase_units?.[0]?.payments?.captures?.[0]?.status;
    if (status !== "COMPLETED") {
      return res
        .status(400)
        .json({ error: `Unexpected PayPal status: ${status || "unknown"}`, details: cap });
    }

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
      email: payer?.email_address || "",
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

/**
 * ==== Shopify: Draft Order -> Complete ====
 * يستقبل line_items مع price لو متوفر (سعر للوحدة بعد التوزيع)
 * الهدف: تسجيل نفس المبلغ النهائي اللي اندفع على PayPal داخل Shopify.
 */
app.post("/api/shopify/order-from-paypal", async (req, res) => {
  try {
    const b = req.body || {};
    const errs = [];
    if (!Array.isArray(b.line_items) || b.line_items.length === 0)
      errs.push("line_items is required");

    const A = b.address || {};
    // لا ترسل email داخل العناوين — Shopify MailingAddressInput ما فيه email
    ["firstName", "lastName", "address1", "city", "zip", "country"].forEach(
      (k) => {
        if (!A[k]) errs.push(`address.${k} is required`);
      }
    );

    if (b.shipping_label == null) errs.push("shipping_label is required");
    if (b.shipping_price == null) errs.push("shipping_price is required");

    if (errs.length)
      return res.status(400).json({ error: "Invalid payload", details: errs });

    // جهّز lineItems لِـ draftOrderCreate.
    // لو في price بالبايلود (string/number) نمرّره، وإلا نخليه null عشان Shopify يستخدم سعر المتغير.
    const draftLineItems = b.line_items.map((li) => ({
      variantId: toVariantGID(li.variant_id),
      quantity: parseInt(li.quantity, 10),
      price:
        li.price !== undefined && li.price !== null && li.price !== ""
          ? String(li.price)
          : null,
    }));

    const draftOrderCreate = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id }
          userErrors { field message }
        }
      }
    `;

    const draftInput = {
      // ما نحط email في العناوين – بس على مستوى الدرافـت ممكن نحط A.email اذا بدك كـ customerEmail
      email: A.email || undefined,
      billingAddress: {
        firstName: A.firstName,
        lastName: A.lastName,
        address1: A.address1,
        city: A.city,
        zip: A.zip,
        country: A.country,
        phone: A.phone || null,
      },
      shippingAddress: {
        firstName: A.firstName,
        lastName: A.lastName,
        address1: A.address1,
        city: A.city,
        zip: A.zip,
        country: A.country,
        phone: A.phone || null,
      },
      lineItems: draftLineItems,
      shippingLine:
        b.shipping_price !== "" && b.shipping_price != null
          ? {
              title: b.shipping_label || "Shipping",
              price: String(b.shipping_price),
            }
          : null,
      note: `PayPal order: ${b.paypalOrderId || ""} | capture: ${
        b.paypalCaptureId || ""
      }`.trim(),
    };

    const d1 = await shopifyGraphQL(draftOrderCreate, { input: draftInput });
    const ue1 = d1?.draftOrderCreate?.userErrors || [];
    if (ue1.length)
      return res.status(400).json({ error: "Shopify user errors", details: ue1 });

    const draftId = d1?.draftOrderCreate?.draftOrder?.id;
    if (!draftId)
      return res
        .status(400)
        .json({ error: "Failed to create draft order", details: d1 });

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
      return res
        .status(400)
        .json({ error: "Unable to complete draft order", details: d2 });

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
