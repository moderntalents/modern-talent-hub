"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Card";
import { ErrorBanner } from "@/components/ui/EmptyState";

export function WithdrawalActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [reference, setReference] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function updateStatus(newStatus: string, extra: Record<string, string> = {}) {
    setLoading(newStatus);
    setError(null);
    try {
      const res = await fetch(`/api/withdrawals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update withdrawal.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update withdrawal.");
    } finally {
      setLoading(null);
    }
  }

  if (status === "failed") {
    return null;
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {status === "pending" && (
        <div className="flex gap-2">
          <Button variant="outline" loading={loading === "processing"} onClick={() => updateStatus("processing")}>
            Mark processing
          </Button>
          <Button variant="danger" loading={loading === "failed"} onClick={() => updateStatus("failed")}>
            Reject
          </Button>
        </div>
      )}
      {status === "processing" && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="M-Pesa/bank reference once actually sent"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="w-56"
          />
          <Button
            loading={loading === "successful"}
            onClick={() => updateStatus("successful", { providerReference: reference })}
          >
            Mark successful
          </Button>
          <Button variant="danger" loading={loading === "failed"} onClick={() => updateStatus("failed")}>
            Mark failed
          </Button>
        </div>
      )}
      {status === "successful" && (
        <Button variant="danger" loading={loading === "reversed"} onClick={() => updateStatus("reversed")}>
          Mark reversed
        </Button>
      )}
      {error && <ErrorBanner message={error} />}
    </div>
  );
}
