import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

const INDIVIDUAL_UPGRADES = [
  { tier: "individual_100mb", label: "100MB", price: "R99 once off" },
  { tier: "individual_250mb", label: "250MB", price: "R199 once off" },
];

const COMPANY_UPGRADES = [
  { tier: "company_1gb", label: "1GB", price: "R299 once off" },
  { tier: "company_10gb", label: "10GB", price: "R469 once off" },
];

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

export default function StorageMeter({ email }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadStatus() {
      setLoading(true);
      const { data, error } = await supabase
        .from("storage_status")
        .select("*")
        .eq("email", email)
        .single();

      if (!cancelled) {
        if (!error) setStatus(data);
        setLoading(false);
      }
    }

    loadStatus();
    return () => {
      cancelled = true;
    };
  }, [email]);

  async function handleUpgrade(tier) {
    setUpgrading(tier);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/storage-checkout`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token ?? ""}`,
          },
          body: JSON.stringify({ email, upgrade_tier: tier }),
        },
      );

      if (!res.ok) throw new Error("Checkout request failed");

      const { payfast_url, fields } = await res.json();

      const form = document.createElement("form");
      form.method = "POST";
      form.action = payfast_url;
      for (const [key, value] of Object.entries(fields)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = String(value);
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      console.error(err);
      setUpgrading(null);
    }
  }

  if (loading) {
    return (
      <div style={{ padding: "1.25rem", fontSize: 13, color: "#5B6472" }}>
        Loading storage usage…
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const isCompany = status.tier === "company";
  const upgrades = isCompany ? COMPANY_UPGRADES : INDIVIDUAL_UPGRADES;
  const pct = Math.min(status.pct_used, 100);
  const barColor = pct >= 90 ? "#D14343" : pct >= 70 ? "#E0A32C" : "#1D5A8C";

  return (
    <div
      style={{
        maxWidth: 420,
        background: "#EEF4F9",
        borderRadius: 16,
        padding: "1.25rem",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "#14171A" }}>Storage</span>
        <span style={{ fontSize: 13, color: "#5B6472" }}>
          {formatBytes(status.used_bytes)} of {formatBytes(status.limit_bytes)}
        </span>
      </div>

      <div
        style={{
          height: 8,
          background: "#D7E3EE",
          borderRadius: 4,
          overflow: "hidden",
          marginBottom: 16,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: barColor,
            borderRadius: 4,
            transition: "width 0.3s ease",
          }}
        />
      </div>

      {pct >= 70 && (
        <p style={{ fontSize: 13, color: "#5B6472", margin: "0 0 12px" }}>
          {pct >= 90
            ? "You're almost out of space. Upgrade to keep uploading."
            : "You're close to your limit. Upgrade for more space."}
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {upgrades.map((opt) => (
          <button
            key={opt.tier}
            onClick={() => handleUpgrade(opt.tier)}
            disabled={upgrading === opt.tier}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              padding: "10px 14px",
              background: "#FFFFFF",
              border: "1px solid #D7E3EE",
              borderRadius: 12,
              cursor: upgrading === opt.tier ? "default" : "pointer",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "#14171A" }}>
              {upgrading === opt.tier ? "Redirecting…" : opt.label}
            </span>
            <span style={{ fontSize: 12, color: "#5B6472" }}>{opt.price}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
