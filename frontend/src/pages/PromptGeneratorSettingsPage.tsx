import React from "react";
import { getFeatureExtractionPromptGeneratorMeta, saveFeatureExtractionPromptGeneratorMeta } from "../api/client";

export default function PromptGeneratorSettingsPage() {
  const [promptGeneratorMeta, setPromptGeneratorMeta] = React.useState("");
  const [promptGeneratorMetaPath, setPromptGeneratorMetaPath] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getFeatureExtractionPromptGeneratorMeta();
        if (cancelled) return;
        setPromptGeneratorMeta(cfg.template ?? "");
        setPromptGeneratorMetaPath(cfg.path ?? null);
      } catch {
        if (!cancelled) setStatus("Не удалось загрузить базовый текст генератора промптов.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    const txt = String(promptGeneratorMeta || "").trim();
    if (!txt) {
      setStatus("Базовый текст не может быть пустым.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const saved = await saveFeatureExtractionPromptGeneratorMeta(txt);
      setPromptGeneratorMeta(saved.template);
      setPromptGeneratorMetaPath(saved.path ?? null);
      setStatus("Базовый текст генератора промптов сохранён.");
      window.setTimeout(() => setStatus(null), 4000);
    } catch (e: any) {
      setStatus(e?.message ?? "Ошибка сохранения базового текста.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0f172a" }}>Генератор промптов</h2>
        <p style={{ margin: 0, color: "#334155", lineHeight: 1.5, fontSize: 14 }}>
          Этот базовый текст используется как инструкция для модели, которая формирует системный текст извлечения признаков.
        </p>
        {promptGeneratorMetaPath ? (
          <p style={{ margin: 0, color: "#64748b", lineHeight: 1.45, fontSize: 12 }}>
            Путь конфигурации: <code className="fe-font-mono">{promptGeneratorMetaPath}</code>
          </p>
        ) : null}
        <textarea
          className="fe-textarea-code"
          value={promptGeneratorMeta}
          onChange={(e) => setPromptGeneratorMeta(e.target.value)}
          style={{
            minHeight: 220,
            maxHeight: "min(50vh, 420px)",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 12,
            color: "#0f172a",
          }}
        />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" className="btn" disabled={busy} onClick={() => void onSave()}>
            {busy ? "Сохранение..." : "Сохранить базовый текст"}
          </button>
          {status ? (
            <span
              style={{
                color: status.includes("Ошибка") || status.includes("ошибка") || status.includes("Не удалось") ? "#b91c1c" : "#166534",
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              {status}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
