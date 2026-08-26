import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

const TIER_LABELS = {
  individual_100mb: "100MB",
  individual_250mb: "250MB",
  company_1gb: "1GB",
  company_10gb: "10GB",
};

export default function UpgradeSuccess() {
  const params = new URLSearchParams(window.location.search);
  const purchaseId = params.get("m_payment_id") || params.get("purchase_id");

  const [purchase, setPurchase] = useState(null);
  const [status, setStatus] = useState("pending"); // 'pending' | 'complete' | 'not_found'

  useEffect(() => {
    if (!purchaseId) {
      setStatus("not_found");
      return;
    }

    let cancelled = false;
    let attempts = 0;

    async function poll() {
      attempts += 1;
      const { data, error } = await supabase
        .from("storage_purchases")
        .select("upgrade_tier, amount_zar, status")
        .eq("id", purchaseId)
        .single();

      if (cancelled) return;

      if (error || !data) {
        setStatus("not_found");
        return;
      }

      setPurchase(data);

      if (data.status === "complete") {
        setStatus("complete");
      } else if (attempts < 8) {
        setTimeout(poll, 2000);
      } else {
        setStatus("pending");
      }
    }

    poll();
    return () => {
      cancelled = true;
    };
  }, [purchaseId]);

  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#EEF4F9",
        padding: "2rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 440,
          width: "100%",
          background: "#FFFFFF",
          borderRadius: 16,
          padding: "2.5rem 2rem",
          textAlign: "center",
        }}
      >
        {status === "complete" && (
          <>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                background: "#1D5A8C",
                color: "#FFFFFF",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
                margin: "0 auto 1.25rem",
              }}
            >
              ✓
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 0.5rem", color: "#14171A" }}>
              Storage upgraded
            </h1>
            <p style={{ color: "#5B6472", fontSize: 15, margin: "0 0 1.5rem" }}>
              {purchase
                ? `Your storage limit is now ${TIER_LABELS[purchase.upgrade_tier] ?? "upgraded"}.`
                : "Your storage limit has been upgraded."}
            </p>
          </>
        )}

        {status === "pending" && (
          <>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "50%",
                border: "3px solid #D7E3EE",
                borderTopColor: "#1D5A8C",
                margin: "0 auto 1.25rem",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 0.5rem", color: "#14171A" }}>
              Confirming payment
            </h1>
            <p style={{ color: "#5B6472", fontSize: 15, margin: "0 0 1.5rem" }}>
              PayFast is finalising your payment. This usually takes a few seconds.
              {purchase && ` Amount: R${purchase.amount_zar}.`}
            </p>
          </>
        )}

        {status === "not_found" && (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 0.5rem", color: "#14171A" }}>
              We couldn't find that payment
            </h1>
            <p style={{ color: "#5B6472", fontSize: 15, margin: "0 0 1.5rem" }}>
              If you completed a payment, it may still be processing. Check your storage
              usage in a minute, or contact support if it doesn't update.
            </p>
          </>
        )}

        <a
          href="/dashboard"
          style={{
            display: "inline-block",
            background: "#1D5A8C",
            color: "#FFFFFF",
            padding: "12px 24px",
            borderRadius: 9999,
            textDecoration: "none",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Back to dashboard
        </a>
      </div>
    </div>
  );
}
