import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const AFRICA_CURRENCIES = new Set([
  "KES", "UGX", "TZS", "RWF", "BIF", "SSP", "ETB", "SOS", "DJF", "ERN",
  "NGN", "GHS", "XOF", "XAF", "GMD", "GNF", "LRD", "SLE", "CVE", "MRU", "STN",
  "ZAR", "ZMW", "MWK", "MZN", "BWP", "NAD", "LSL", "SZL", "AOA", "CDF", "ZWG",
  "MUR", "SCR", "KMF", "MGA",
  "EGP", "MAD", "DZD", "TND", "LYD", "SDG",
]);

const PESAPAL_HEADERS = {
  "Accept": "application/json",
  "Content-Type": "application/json",
};

function getPesapalBaseUrl() {
  const isLive = (process.env.PESAPAL_ENV || "live").trim() === "live";
  return isLive ? "https://pesapal.com" : "https://pesapal.com";
}

async function getPesapalToken() {
  const consumerKey = (process.env.PESAPAL_CONSUMER_KEY || "").trim();
  const consumerSecret = (process.env.PESAPAL_CONSUMER_SECRET || "").trim();
  if (!consumerKey || !consumerSecret) {
    throw new Error("Missing PESAPAL_CONSUMER_KEY or PESAPAL_CONSUMER_SECRET on relay server.");
  }

  const res = await fetch(`${getPesapalBaseUrl()}/api/Auth/RequestToken`, {
    method: "POST",
    headers: PESAPAL_HEADERS,
    body: JSON.stringify({
      consumer_key: consumerKey,
      consumer_secret: consumerSecret,
    }),
  });

  const data = await res.json();
  if (!data?.token) {
    throw new Error(data?.error?.message || data?.message || "Failed to get Pesapal token");
  }
  return data.token;
}

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "UzaTrack Pesapal Relay" });
});

app.post("/pesapal-checkout", async (req, res) => {
  try {
    const {
      phone,
      email,
      amount,
      currency = "KES",
      africa_only = false,
      plan,
      billing_cycle,
      callback_url,
    } = req.body || {};

    const upperCurrency = String(currency).toUpperCase();
    if (africa_only && !AFRICA_CURRENCIES.has(upperCurrency)) {
      throw new Error("Africa regional pricing is restricted to African currencies and mobile money.");
    }
    if (africa_only && (!phone || String(phone).trim().length < 8)) {
      throw new Error("A valid African mobile money number is required for regional checkout.");
    }

    const token = await getPesapalToken();
    const baseUrl = getPesapalBaseUrl();

    let ipnId = (process.env.PESAPAL_IPN_ID || "").trim();
    if (!ipnId) {
      const publicUrl = (process.env.PUBLIC_RELAY_URL || `https://${req.get("host")}`).replace(/\/$/, "");
      const regRes = await fetch(`${baseUrl}/api/URLSetup/RegisterIPN`, {
        method: "POST",
        headers: { ...PESAPAL_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          url: `${publicUrl}/pesapal-ipn`,
          ipn_notification_type: "GET",
        }),
      });
      const regData = await regRes.json();
      if (!regData?.ipn_id) {
        throw new Error(regData?.error?.message || "Could not register Pesapal IPN URL");
      }
      ipnId = regData.ipn_id;
    }

    const merchantReference = `UZA-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const orderRes = await fetch(`${baseUrl}/api/Transactions/SubmitOrderRequest`, {
      method: "POST",
      headers: { ...PESAPAL_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: merchantReference,
        currency: upperCurrency,
        amount: Number(amount),
        description: `UzaTrack ${String(plan).toUpperCase()} (${billing_cycle})`,
        callback_url: callback_url || "https://uzatrack.com",
        notification_id: ipnId,
        billing_address: {
          email_address: email?.trim() || "billing@uzatrack.com",
          phone_number: phone?.trim() || "",
          country_code: upperCurrency === "KES" ? "KE" : africa_only ? "KE" : "US",
          first_name: "UzaTrack",
          last_name: "Customer",
        },
      }),
    });

    const orderData = await orderRes.json();
    if (!orderData?.redirect_url) {
      throw new Error(orderData?.error?.message || orderData?.message || "Pesapal order failed");
    }

    res.json({
      redirect_url: orderData.redirect_url,
      order_tracking_id: orderData.order_tracking_id,
      merchant_reference: merchantReference,
    });
  } catch (err) {
    res.json({ error: err?.message || "Pesapal checkout error" });
  }
});

app.all("/pesapal-ipn", async (req, res) => {
  try {
    const orderTrackingId = req.query.OrderTrackingId || req.body?.OrderTrackingId;
    const orderMerchantReference =
      req.query.OrderMerchantReference || req.body?.OrderMerchantReference || "";
    const orderNotificationType =
      req.query.OrderNotificationType || req.body?.OrderNotificationType || "IPNCHANGE";

    if (!orderTrackingId) {
      throw new Error("Missing OrderTrackingId");
    }

    const token = await getPesapalToken();
    const statusRes = await fetch(
      `${getPesapalBaseUrl()}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(
        orderTrackingId
      )}`,
      { headers: { ...PESAPAL_HEADERS, Authorization: `Bearer ${token}` } }
    );
    const statusData = await statusRes.json();
    const isCompleted =
      Number(statusData?.status_code) === 1 ||
      String(statusData?.payment_status_description || "").toUpperCase() === "COMPLETED";

    const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
    const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

    if (supabaseUrl && serviceRoleKey) {
      const sbHeaders = {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=representation",
      };

      const txRes = await fetch(
        `${supabaseUrl}/rest/v1/payment_transactions?or=(provider_reference.eq.${encodeURIComponent(
          orderTrackingId
        )},reference.eq.${encodeURIComponent(orderMerchantReference || "NONE")})&limit=1`,
        { headers: sbHeaders }
      );
      const txRows = txRes.ok ? await txRes.json() : [];
      const tx = Array.isArray(txRows) ? txRows : null;

      if (tx?.id) {
        await fetch(
          `${supabaseUrl}/rest/v1/payment_transactions?id=eq.${encodeURIComponent(tx.id)}`,
          {
            method: "PATCH",
            headers: sbHeaders,
            body: JSON.stringify({
              status: isCompleted ? "completed" : "pending",
              provider_reference: orderTrackingId,
            }),
          }
        );

        if (isCompleted && tx.owner_id) {
          const isBusiness = tx.plan === "business";
          const isYearly = String(tx.notes || "").includes("Cycle: yearly");
          const expiresAt = new Date();
          if (isBusiness || isYearly) {
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
          } else {
            expiresAt.setDate(expiresAt.getDate() + 30);
          }

          await fetch(
            `${supabaseUrl}/rest/v1/subscriptions?owner_id=eq.${encodeURIComponent(tx.owner_id)}`,
            {
              method: "PATCH",
              headers: sbHeaders,
              body: JSON.stringify({
                plan: tx.plan,
                status: "active",
                billing_cycle: isBusiness ? "one_time_license" : isYearly ? "yearly" : "monthly",
                current_period_end: expiresAt.toISOString(),
              }),
            }
          );
        }
      }
    }

    res.json({
      orderNotificationType,
      orderTrackingId,
      orderMerchantReference,
      status: 200,
    });
  } catch (err) {
    res.json({ status: 500, error: err?.message || "IPN error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Pesapal relay running on port ${PORT}`));
