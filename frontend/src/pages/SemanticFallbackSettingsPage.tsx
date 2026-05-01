import React from "react";
import {
  getClassNamingGenerationConfig,
  getClassNamingPromptTemplate,
  getPipelineConfig,
  saveClassNamingGenerationConfig,
  saveClassNamingPromptTemplate,
  savePipelineConfig,
} from "../api/client";
import PrimaryCatalogSettingsSection from "../ui/PrimaryCatalogSettingsSection";

export default function SemanticFallbackSettingsPage() {
  const [semanticThreshold, setSemanticThreshold] = React.useState<number>(0.75);
  const [semanticNeighborFloorS0, setSemanticNeighborFloorS0] = React.useState<number>(0.35);
  const [semanticSupportTau2, setSemanticSupportTau2] = React.useState<number>(0.55);
  const [status, setStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [classNamingPrompt, setClassNamingPrompt] = React.useState("");
  const [classNamingPromptPath, setClassNamingPromptPath] = React.useState<string | null>(null);
  const [classNamingGenerationPath, setClassNamingGenerationPath] = React.useState<string | null>(null);
  const [classNamingStatus, setClassNamingStatus] = React.useState<string | null>(null);
  const [classNamingBusy, setClassNamingBusy] = React.useState(false);
  const [classNamingMaxNewTokens, setClassNamingMaxNewTokens] = React.useState<number>(24);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getPipelineConfig();
        const t = cfg?.effective?.semantic_similarity_threshold;
        const s0 = cfg?.effective?.semantic_neighbor_similarity_floor_s0;
        const tau2 = cfg?.effective?.semantic_support_threshold_tau2;
        if (!cancelled && typeof t === "number" && Number.isFinite(t)) {
          setSemanticThreshold(t);
        }
        if (!cancelled && typeof s0 === "number" && Number.isFinite(s0)) {
          setSemanticNeighborFloorS0(s0);
        }
        if (!cancelled && typeof tau2 === "number" && Number.isFinite(tau2)) {
          setSemanticSupportTau2(tau2);
        }
      } catch {
        if (!cancelled) setStatus("Не удалось загрузить сохранённый порог.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, genCfg] = await Promise.all([getClassNamingPromptTemplate(), getClassNamingGenerationConfig()]);
        if (cancelled) return;
        setClassNamingPrompt(cfg.template ?? "");
        setClassNamingPromptPath(cfg.path ?? null);
        setClassNamingMaxNewTokens(
          typeof genCfg.max_new_tokens === "number" && Number.isFinite(genCfg.max_new_tokens) ? genCfg.max_new_tokens : 24,
        );
        setClassNamingGenerationPath(genCfg.path ?? null);
      } catch {
        if (!cancelled) setClassNamingStatus("Не удалось загрузить промпт генерации имени класса.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    const next = Number(semanticThreshold);
    const nextS0 = Number(semanticNeighborFloorS0);
    const nextTau2 = Number(semanticSupportTau2);
    if (!Number.isFinite(next) || next < 0 || next > 1) {
      setStatus("τ1 должен быть числом в диапазоне 0…1.");
      return;
    }
    if (!Number.isFinite(nextS0) || nextS0 < -1 || nextS0 > 1) {
      setStatus("s0 должен быть числом в диапазоне -1…1.");
      return;
    }
    if (!Number.isFinite(nextTau2) || nextTau2 < 0 || nextTau2 > 1) {
      setStatus("τ2 должен быть числом в диапазоне 0…1.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await savePipelineConfig({
        semantic_similarity_threshold: next,
        semantic_neighbor_similarity_floor_s0: nextS0,
        semantic_support_threshold_tau2: nextTau2,
      });
      setStatus("Параметры семантической проверки сохранены.");
      window.setTimeout(() => setStatus(null), 4000);
    } catch (e: any) {
      setStatus(e?.message ?? "Ошибка сохранения порога.");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveClassNamingSettings() {
    const txt = String(classNamingPrompt || "").trim();
    if (!txt) {
      setClassNamingStatus("Промпт не может быть пустым.");
      return;
    }
    const maxTokens = Number(classNamingMaxNewTokens);
    if (!Number.isFinite(maxTokens) || maxTokens < 8 || maxTokens > 256) {
      setClassNamingStatus("max_new_tokens должен быть числом в диапазоне 8…256.");
      return;
    }
    setClassNamingBusy(true);
    setClassNamingStatus(null);
    try {
      const [saved, savedCfg] = await Promise.all([
        saveClassNamingPromptTemplate(txt),
        saveClassNamingGenerationConfig(Math.round(maxTokens)),
      ]);
      setClassNamingPrompt(saved.template);
      setClassNamingPromptPath(saved.path ?? null);
      setClassNamingMaxNewTokens(savedCfg.max_new_tokens);
      setClassNamingGenerationPath(savedCfg.path ?? null);
      setClassNamingStatus("Промпт и параметры генерации имени класса сохранены.");
      window.setTimeout(() => setClassNamingStatus(null), 4000);
    } catch (e: any) {
      setClassNamingStatus(e?.message ?? "Ошибка сохранения настроек генерации имени класса.");
    } finally {
      setClassNamingBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <PrimaryCatalogSettingsSection />
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", display: "grid", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0f172a" }}>
          Параметры семантической проверки
        </h2>
        <p style={{ margin: 0, color: "#334155", lineHeight: 1.5, fontSize: 14 }}>
          Если классификация по правилам справочника не выбрала класс, включается проверка по методу k ближайших соседей.
          Автоматическое назначение класса происходит только если одновременно выполнены условия:{" "}
          <strong style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>
            V<sub>best</sub>(c<sup>^</sup>) &gt; τ<sub>1</sub>
          </strong>{" "}
          и{" "}
          <strong style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>
            P(c<sup>^</sup>) &gt; τ<sub>2</sub>
          </strong>
          . Если хотя бы одно условие не выполнено, автоприсвоение класса не делается и требуется экспертная проверка.
        </p>
        <p style={{ margin: 0, color: "#64748b", lineHeight: 1.55, fontSize: 13 }}>
          Здесь{" "}
          <strong style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>
            V<sub>best</sub>(c<sup>^</sup>)
          </strong>{" "}
          — лучшая схожесть среди соседей выбранного класса, а{" "}
          <strong style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>P(c<sup>^</sup>)</strong> — доля
          суммарного веса этого класса после отсечения слабых соседей порогом{" "}
          <strong style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>s<sub>0</sub></strong>.
        </p>
        <div
          style={{
            marginTop: 2,
            padding: "10px 12px",
            border: "1px solid #e2e8f0",
            background: "#f8fafc",
            borderRadius: 8,
            fontSize: 12,
            color: "#334155",
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>
            <strong style={{ fontFamily: "inherit" }}>Формула:</strong> match = 1, если V<sub>best</sub>(c<sup>^</sup>)
            &gt; τ<sub>1</sub> и P(c<sup>^</sup>) &gt; τ<sub>2</sub>; иначе match = 0.
          </div>
          <div style={{ marginTop: 6 }}>
            <strong>Смысл коэффициентов:</strong> τ<sub>1</sub> — минимальная сила лучшего совпадения; s<sub>0</sub> —
            отсечка слабых соседей (вес соседа{" "}
            <span style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>w = max(0, s - s<sub>0</sub>)</span>
            ); τ<sub>2</sub> — минимальная коллективная поддержка выбранного класса.
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>
              τ<sub>1</sub> · порог лучшего совпадения{" "}
              <span style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>
                V<sub>best</sub>(c<sup>^</sup>)
              </span>{" "}
              (0…1)
            </span>
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
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>
              s<sub>0</sub> · отсечка слабых соседей перед голосованием (-1…1)
            </span>
            <input
              type="number"
              min={-1}
              max={1}
              step={0.01}
              value={semanticNeighborFloorS0}
              onChange={(e) => setSemanticNeighborFloorS0(Number(e.target.value))}
              style={{ width: 90, padding: "6px 8px", borderRadius: 6, border: "1px solid #cbd5e1" }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>
              τ<sub>2</sub> · минимальная нормированная поддержка{" "}
              <span style={{ fontFamily: `"Cambria Math", "Times New Roman", serif` }}>P(c<sup>^</sup>)</span> (0…1)
            </span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={semanticSupportTau2}
              onChange={(e) => setSemanticSupportTau2(Number(e.target.value))}
              style={{ width: 90, padding: "6px 8px", borderRadius: 6, border: "1px solid #cbd5e1" }}
            />
          </label>
          <button type="button" className="btn" disabled={busy} onClick={() => void onSave()}>
            {busy ? "Сохранение..." : "Сохранить параметры"}
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
            Текст запроса для генерации имени класса
          </h2>
          <p style={{ margin: 0, color: "#334155", lineHeight: 1.5, fontSize: 14 }}>
            Этот промпт используется сервисом генерации имени класса, когда не удалось назначать класс товару в соответствии с правилами, а модуль определения семантической близости определил схожесть с имеющимися декларациями ниже порога.
          </p>
          {classNamingPromptPath ? (
            <p style={{ margin: 0, color: "#64748b", lineHeight: 1.45, fontSize: 12 }}>
              Путь конфигурации: <code className="fe-font-mono">{classNamingPromptPath}</code>
            </p>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600 }}>Ограничение длины ответа</span>
              <input
                type="number"
                min={8}
                max={256}
                step={1}
                value={classNamingMaxNewTokens}
                onChange={(e) => setClassNamingMaxNewTokens(Number(e.target.value))}
                style={{ width: 110, padding: "6px 8px", borderRadius: 6, border: "1px solid #cbd5e1" }}
              />
            </label>
            <span style={{ color: "#64748b", fontSize: 12 }}>
              Рекомендация для 1-3 слов: от 16 до 32 токенов (служебный параметр модели).
            </span>
          </div>
          {classNamingGenerationPath ? (
            <p style={{ margin: 0, color: "#64748b", lineHeight: 1.45, fontSize: 12 }}>
              Путь параметров генерации: <code className="fe-font-mono">{classNamingGenerationPath}</code>
            </p>
          ) : null}
          <textarea
            className="fe-textarea-code"
            value={classNamingPrompt}
            onChange={(e) => setClassNamingPrompt(e.target.value)}
            spellCheck={false}
            style={{
              minHeight: 220,
              maxHeight: "min(55vh, 520px)",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              border: "1px solid #cbd5e1",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 12,
              color: "#0f172a",
            }}
          />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" className="btn" disabled={classNamingBusy} onClick={() => void onSaveClassNamingSettings()}>
              {classNamingBusy ? "Сохранение..." : "Сохранить промпт и параметры"}
            </button>
            {classNamingStatus ? (
              <span
                style={{
                  color:
                    classNamingStatus.includes("Ошибка") ||
                    classNamingStatus.includes("ошибка") ||
                    classNamingStatus.includes("Не удалось")
                      ? "#b91c1c"
                      : "#166534",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                {classNamingStatus}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
