"use client";

import { useState } from "react";

interface Props {
  token: string;
  category?: string;
  labels: {
    confirm: string;
    processing: string;
    done: string;
    failed: string;
    network: string;
    doneText: string;
  };
}

export function UnsubscribeForm({ token, category, labels }: Props) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "failed">(
    "idle",
  );
  const buttonText = (() => {
    switch (state) {
      case "loading":
        return labels.processing;
      case "done":
        return labels.done;
      case "failed":
        return labels.failed;
      default:
        return labels.confirm;
    }
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("loading");
    try {
      const res = await fetch("/api/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(category ? { category } : {}) }),
      });
      const data = (await res.json()) as { ok?: boolean };
      setState(data.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <form onSubmit={submit}>
      <button
        type="submit"
        disabled={state === "loading" || state === "done"}
        style={{
          marginTop: 16,
          padding: "10px 24px",
          background: state === "done" ? "#16a34a" : "#dc2626",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: state === "loading" || state === "done" ? "default" : "pointer",
          fontSize: 15,
        }}
      >
        {buttonText}
      </button>
      {state === "done" ? (
        <p style={{ marginTop: 12 }}>{labels.doneText}</p>
      ) : state === "failed" ? (
        <p style={{ marginTop: 12, color: "#dc2626" }}>{labels.network}</p>
      ) : null}
    </form>
  );
}
