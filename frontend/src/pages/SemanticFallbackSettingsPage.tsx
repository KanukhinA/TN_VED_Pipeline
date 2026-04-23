import React from "react";
import { getPipelineConfig, savePipelineConfig } from "../api/client";
import { FEATURE_EXTRACTION_PROMPT_GENERATOR_META } from "../expert/featureExtractionPromptGenerator";
import PrimaryCatalogSettingsSection from "../ui/PrimaryCatalogSettingsSection";

export default function SemanticFallbackSettingsPage() {
  const [semanticThreshold, setSemanticThreshold] = React.useState<number>(0.75);
  const [status, setStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getPipelineConfig();
        const t = cfg?.effective?.semantic_similarity_threshold;
        if (!cancelled && typeof t === "number" && Number.isFinite(t)) {
          setSemanticThreshold(t);
        }
      } catch {
        if (!cancelled) setStatus("Не удалось загрузить сохранённый порог.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    const next = Number(semanticThreshold);
    if (!Number.isFinite(next) || next < 0 || next > 1) {
      setStatus("Порог должен быть числом в диапазоне 0…1.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await savePipelineConfig({ semantic_similarity_threshold: next });
      setStatus("Порог сохранен.");
      window.setTimeout(() => setStatus(null), 4000);
    } catch (e: any) {
      setStatus(e?.message ?? "Ошибка сохранения порога.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <PrimaryCatalogSettingsSection />
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", display: "grid", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0f172a" }}>
          Порог семантической схожести (SimCheck)
        </h2>
        <p style={{ margin: 0, color: "#334155", lineHeight: 1.5, fontSize: 14 }}>
          Если классификация по правилам справочника не выбрала класс, выполняется семантический поиск (SimCheck). При
          схожести <strong>не выше</strong> этого порога запускается генерация имени класса моделью; имя не применяется без
          подтверждения эксперта.
        </p>
        <p style={{ margin: 0, color: "#64748b", lineHeight: 1.55, fontSize: 13 }}>
          Схожесть считается по эталонам из датасета справочника. Подробности и режим работы поиска отображаются в результате
          проверки декларации.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>Порог 0…1</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={semanticThreshold}
              onChange={(e) => setSemanticThreshold(Number(e.target.value))}
              style={{ width: 90, padding: "6px 8px", borderRadius: 6, border: "1px solid #cbd5e1" }}
            />
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void onSave()}>
            {busy ? "Сохранение..." : "Сохранить порог"}
          </button>
        </div>

        {status ? (
          <div
            style={{
              color:
                status.includes("Ошибка") || status.includes("ошибка") || status.includes("Не удалось")
                  ? "#b91c1c"
                  : "#166534",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {status}
          </div>
        ) : null}
      </div>
    </div>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 18px", display: "grid", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0f172a" }}>
            Базовый текст промпта для генерации промптов
          </h2>
          <p style={{ margin: 0, color: "#334155", lineHeight: 1.5, fontSize: 14 }}>
            Этот текст используется как мета-инструкция для модели, которая генерирует системный промпт извлечения признаков.
          </p>
          <textarea
            className="fe-textarea-code"
            value={FEATURE_EXTRACTION_PROMPT_GENERATOR_META}
            readOnly
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
        </div>
      </div>
    </div>
  );
}
