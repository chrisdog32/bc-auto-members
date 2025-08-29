// Vercel Serverless Function: /api/order-webhook
// 1) Moves a logged-in buyer into Members Only (BigCommerce customer group)
// 2) Upserts them into Mailchimp audience with tag "Members Only"

import crypto from "node:crypto";

const BC_STORE_HASH = process.env.BC_STORE_HASH;              // e.g., "713e0"
const BC_ACCESS_TOKEN = process.env.BC_ACCESS_TOKEN;          // from your BC API account
const MEMBERS_ONLY_GROUP_ID = parseInt(process.env.MEMBERS_ONLY_GROUP_ID || "6", 10);

// Accept either name for the audience/list id
const MC_LIST_ID = process.env.MC_AUDIENCE_ID || process.env.MC_LIST_ID || "";
const MC_API_KEY = process.env.MC_API_KEY || "";
const MC_DC = MC_API_KEY ? MC_API_KEY.split("-").pop() : "";  // e.g., "us21"

const BC_API_BASE = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}`;

// Body can arrive as a string on some runtimes; normalize to JSON
function getJsonBody(req) {
  if (!req || !req.body) return {};
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ message: "Method not allowed" });
    }

    const body = getJsonBody(req);
    const orderId = body?.data?.id;
    if (!orderId) {
      console.log("Webhook received without order id:", body);
      return res.status(200).json({ message: "No order id in payload; ignoring" });
    }

    // --- 1) Fetch order (BC v2) ---
    const orderResp = await fetch(`${BC_API_BASE}/v2/orders/${orderId}`, {
      headers: {
        "X-Auth-Token": BC_ACCESS_TOKEN,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
    });
    if (!orderResp.ok) {
      const t = await orderResp.text();
      throw new Error(`Order fetch failed: ${orderResp.status} ${t}`);
    }
    const order = await orderResp.json();

    const status = order.status;
    const customerId = order.customer_id;
    const billing = order.billing_address || {};
    const email = (billing.email || "").trim().toLowerCase();
    const firstName = billing.first_name || "";
    const lastName  = billing.last_name  || "";

    console.log("Order", orderId, "status:", status, "customer_id:", customerId, "email:", email);

    // Only when effectively paid/processing
    const okStatuses = new Set(["Completed", "Shipped", "Awaiting Fulfillment", "Awaiting Shipment"]);
    if (!okStatuses.has(status)) {
      return res.status(200).json({ message: `Order ${orderId} status ${status} not eligible yet` });
    }

    // --- 2) Move to Members Only group in BC (skip guests) ---
    if (customerId) {
      // v3 bulk update expects a plain array payload
      const bcPayload = [
        { id: customerId, customer_group_id: MEMBERS_ONLY_GROUP_ID },
      ];
      const updateResp = await fetch(`${BC_API_BASE}/v3/customers`, {
        method: "PUT",
        headers: {
          "X-Auth-Token": BC_ACCESS_TOKEN,
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bcPayload),
      });
      if (!updateResp.ok) {
        const t = await updateResp.text();
        throw new Error(`Customer update failed: ${updateResp.status} ${t}`);
      }
      console.log(`BC: Customer ${customerId} moved to group ${MEMBERS_ONLY_GROUP_ID} (order ${orderId})`);
    } else {
      console.log(`Order ${orderId} is guest checkout; skipping BC group move`);
    }

    // --- 3) Upsert into Mailchimp (works for logged-in AND guests if email present) ---
    if (email && MC_API_KEY && MC_LIST_ID && MC_DC) {
      await mailchimpUpsert(email, firstName, lastName);
    } else {
      console.log("Mailchimp skipped (missing email or MC config)");
    }

    return res.status(200).json({
      message: `Processed order ${orderId} (${customerId ? `customer ${customerId}` : "guest"})`,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

/* -------------- Mailchimp Helpers -------------- */

function md5Lower(s) {
  return crypto.createHash("md5").update(s.toLowerCase()).digest("hex");
}

function mcAuthHeader() {
  // Basic auth with any username and API key as password
  const token = Buffer.from(`any:${MC_API_KEY}`).toString("base64");
  return `Basic ${token}`;
}

async function mailchimpUpsert(email, firstName, lastName) {
  const memberHash = md5Lower(email);
  const base = `https://${MC_DC}.api.mailchimp.com/3.0`;

  // Upsert member
  const upsertUrl = `${base}/lists/${MC_LIST_ID}/members/${memberHash}`;
  const upsertPayload = {
    email_address: email,
    status_if_new: "subscribed", // or "pending" if you want double opt-in
    merge_fields: { FNAME: firstName, LNAME: lastName },
  };

  const upsertResp = await fetch(upsertUrl, {
    method: "PUT",
    headers: { "Authorization": mcAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(upsertPayload),
  });
  if (!upsertResp.ok) {
    const t = await upsertResp.text();
    throw new Error(`Mailchimp upsert failed: ${upsertResp.status} ${t}`);
  }

  // Add tag "Members Only"
  const tagUrl = `${base}/lists/${MC_LIST_ID}/members/${memberHash}/tags`;
  const tagPayload = { tags: [{ name: "Members Only", status: "active" }] };

  const tagResp = await fetch(tagUrl, {
    method: "POST",
    headers: { "Authorization": mcAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(tagPayload),
  });
  if (!tagResp.ok) {
    const t = await tagResp.text();
    throw new Error(`Mailchimp tag failed: ${tagResp.status} ${t}`);
  }

  console.log(`Mailchimp: upserted ${email} with tag "Members Only"`);
}
