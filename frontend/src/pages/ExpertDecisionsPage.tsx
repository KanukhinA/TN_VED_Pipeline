import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  listExpertDecisions,
  patchExpertDecision,
  type ExpertDecisionItem,
} from "../api/client";

const CATEGORY_LABEL: Record<string, string> = {
  classification_ambiguous: "Несколько подходящих классов",
  classification_none: "Ни одно правило классификации не подошло",
  class_name_confirmation: "Нужно подтвердить название класса",
  inspector_feature_correction: "Правка извлечения признаков (инспектор)",
  other: "Другое",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "ожидает решения",
  resolved: "решено",
  dismissed: "закрыто без решения",
};

function labelCategory(cat: string): string {
  return CATEGORY_LABEL[cat] ?? CATEGORY_LABEL.other;
}

function labelStatus(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** Краткие строки по вложенному объекту признаков (без сырого JSON в интерфейсе). */
function flattenFeatureLines(obj: unknown, prefix = ""): string[] {
  if (obj === null || obj === undefined) return [`${prefix || "·"}: —`];
  const t = typeof obj;
  if (t === "string" || t === "number" || t === "boolean") {
    return [`${prefix || "·"}: ${String(obj)}`];
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return [`${prefix || "·"}: —`];
    const out: string[] = [];
    obj.forEach((item, i) => {
      const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
      out.push(...flattenFeatureLines(item, p));
    });
    return out;
  }
  if (t === "object") {
    const o = obj as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 0) return [`${prefix || "·"}: —`];
    const out: string[] = [];
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push(...flattenFeatureLines(o[k], p));
    }
    return out;
  }
  return [`${prefix || "·"}: ${String(obj)}`];
}

function InspectorCorrectionView({ payload }: { payload: Record<string, unknown> }) {
  const before = payload.parsed_before_override;
  const after = payload.parsed_after_override;
  const beforeLines = flattenFeatureLines(before);
  const afterLines = flattenFeatureLines(after);
  return (
    <div style={{ fontSize: 13, color: "#334155", marginBottom: 12, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, color: "#0f172a" }}>Было (модель)</div>
      <ul style={{ margin: "0 0 14px", paddingLeft: 18 }}>
        {beforeLines.length === 0 ? (
          <li style={{ color: "#94a3b8" }}>(нет данных)</li>
        ) : (
          beforeLines.map((line, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              {line}
            </li>
          ))
        )}
      </ul>
      <div style={{ fontWeight: 600, marginBottom: 6, color: "#0f172a" }}>Стало (инспектор)</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {afterLines.length === 0 ? (
          <li style={{ color: "#94a3b8" }}>(нет данных)</li>
        ) : (
          afterLines.map((line, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              {line}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function formatResolutionRu(res: Record<string, unknown> | null | undefined): string {
  if (!res || Object.keys(res).length === 0) return "";
  const chosen = res.chosen_class_id;
  const confirmed = res.confirmed_class_id;
  if (typeof chosen === "string" && chosen.trim()) {
    return `Выбран класс: ${chosen.trim()}`;
  }
  if (typeof confirmed === "string" && confirmed.trim()) {
    return `Подтверждено название: ${confirmed.trim()}`;
  }
  try {
    return JSON.stringify(res);
  } catch {
    return "";
  }
}

function groupByCategory(items: ExpertDecisionItem[]): Map<string, ExpertDecisionItem[]> {
  const m = new Map<string, ExpertDecisionItem[]>();
  for (const it of items) {
    const k = it.category || "other";
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return m;
}

export default function ExpertDecisionsPage() {
  const [items, setItems] = useState<ExpertDecisionItem[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");

  const load = useCallback(async () => {
    setStatus(null);
    try {
      const list = await listExpertDecisions(filter === "pending" ? { status: "pending" } : undefined);
      setItems(list);
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Не удалось загрузить данные.");
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => groupByCategory(items), [items]);

  async function onResolve(id: string, resolution: Record<string, unknown>) {
    setBusyId(id);
    setStatus(null);
    try {
      await patchExpertDecision(id, { status: "resolved", resolution });
      await load();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Ошибка сохранения.");
    } finally {
      setBusyId(null);
    }
  }

  async function onDismiss(id: string) {
    setBusyId(id);
    setStatus(null);
    try {
      await patchExpertDecision(id, { status: "dismissed", resolution: {} });
      await load();
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "Ошибка.");
    } finally {
      setBusyId(null);
    }
  }

  const shell: React.CSSProperties = {
    width: "100%",
    maxWidth: 720,
    margin: "0 auto",
    paddingBottom: 28,
  };

  return (
    <div style={shell}>
      <header style={{ textAlign: "center", marginBottom: 22 }}>
        <h1 style={{ margin: "0 0 10px", fontSize: 24, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.02em" }}>
          Решение спорных ситуаций
        </h1>
        <p
          style={{
            margin: 0,
            color: "#64748b",
            fontSize: 15,
            lineHeight: 1.6,
            maxWidth: 560,
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          Здесь накапливаются ситуации, где автоматика не может завершить шаг без вашего выбора: неоднозначная классификация,
          отсутствие подходящего правила или сомнительное имя класса, предложенное моделью. Записи появляются при обработке
          деклараций и когда при проверке декларации требуется ваше решение.
        </p>
      </header>

      <div
        className="card"
        style={{
          padding: "14px 18px",
          marginBottom: 18,
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid #e2e8f0",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#334155", fontWeight: 500 }}>
          Показать
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as "pending" | "all")}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 200 }}
          >
            <option value="pending">только ожидающие</option>
            <option value="all">все записи</option>
          </select>
        </label>
        <button type="button" className="btn-secondary" onClick={() => void load()}>
          Обновить
        </button>
      </div>

      {status ? (
        <div
          role="alert"
          style={{
            color: "#b91c1c",
            fontWeight: 600,
            marginBottom: 14,
            fontSize: 14,
            textAlign: "center",
          }}
        >
          {status}
        </div>
      ) : null}

      {items.length === 0 ? (
        <div
          className="card"
          style={{
            border: "1px dashed #cbd5e1",
            background: "#f8fafc",
            color: "#475569",
            textAlign: "center",
            padding: "32px 20px",
          }}
        >
          <p style={{ margin: 0, fontSize: 15 }}>Пока нет записей для выбранного фильтра.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 28 }}>
          {[...grouped.entries()]
            .sort((a, b) => a[0].localeCompare(b[0], "ru"))
            .map(([cat, rows]) => (
              <section key={cat}>
                <h2 style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", margin: "0 0 12px" }}>{labelCategory(cat)}</h2>
                <div style={{ display: "grid", gap: 12 }}>
                  {rows.map((it) => (
                    <div
                      key={it.id}
                      className="card"
                      style={{
                        padding: 16,
                        border: "1px solid #e2e8f0",
                        borderRadius: 10,
                        background: it.status === "pending" ? "#fff" : "#f8fafc",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 13,
                          color: "#64748b",
                          marginBottom: 8,
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "6px 10px",
                          alignItems: "baseline",
                        }}
                      >
                        <span>{it.created_at}</span>
                        <span aria-hidden="true" style={{ color: "#cbd5e1" }}>
                          ·
                        </span>
                        <span>декларация {it.declaration_id}</span>
                        {it.rule_id ? (
                          <>
                            <span aria-hidden="true" style={{ color: "#cbd5e1" }}>
                              ·
                            </span>
                            <span>справочник {it.rule_id}</span>
                          </>
                        ) : null}
                        <span aria-hidden="true" style={{ color: "#cbd5e1" }}>
                          ·
                        </span>
                        <span style={{ fontWeight: 600, color: "#475569" }}>{labelStatus(it.status)}</span>
                      </div>
                      <div style={{ fontSize: 15, color: "#0f172a", marginBottom: 12, lineHeight: 1.5 }}>{it.summary_ru}</div>
                      {it.category === "inspector_feature_correction" ? (
                        <InspectorCorrectionView payload={it.payload_json} />
                      ) : (
                        <details style={{ fontSize: 12, color: "#475569", marginBottom: 12 }}>
                          <summary style={{ cursor: "pointer" }}>Технические подробности</summary>
                          <pre
                            style={{
                              marginTop: 10,
                              padding: 10,
                              background: "#f1f5f9",
                              borderRadius: 8,
                              overflow: "auto",
                              maxHeight: 220,
                              fontSize: 11,
                              textAlign: "left",
                            }}
                          >
                            {JSON.stringify(it.payload_json, null, 2)}
                          </pre>
                        </details>
                      )}
                      {it.status === "pending" ? (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: 12,
                            alignItems: "flex-end",
                            justifyContent: "space-between",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 10,
                              alignItems: "flex-end",
                              flex: "1 1 240px",
                            }}
                          >
                            {(it.category === "classification_ambiguous" || it.category === "classification_none") && (
                              <>
                                <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#334155", minWidth: 200 }}>
                                  <span style={{ fontWeight: 600 }}>Класс в справочнике</span>
                                  <input
                                    type="text"
                                    id={`chosen-${it.id}`}
                                    placeholder="идентификатор из справочника"
                                    autoComplete="off"
                                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                                  />
                                </label>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busyId === it.id}
                                  onClick={() => {
                                    const el = document.getElementById(`chosen-${it.id}`) as HTMLInputElement | null;
                                    const chosen = (el?.value ?? "").trim();
                                    void onResolve(it.id, { chosen_class_id: chosen });
                                  }}
                                >
                                  Сохранить выбор
                                </button>
                              </>
                            )}
                            {it.category === "class_name_confirmation" && (
                              <>
                                <label style={{ display: "grid", gap: 6, fontSize: 13, color: "#334155", minWidth: 220 }}>
                                  <span style={{ fontWeight: 600 }}>Название класса</span>
                                  <input
                                    type="text"
                                    id={`name-${it.id}`}
                                    defaultValue={String(
                                      (it.payload_json?.llm_result as { suggested_class_name?: string } | undefined)
                                        ?.suggested_class_name ?? "",
                                    )}
                                    autoComplete="off"
                                    style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
                                  />
                                </label>
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={busyId === it.id}
                                  onClick={() => {
                                    const el = document.getElementById(`name-${it.id}`) as HTMLInputElement | null;
                                    const name = (el?.value ?? "").trim();
                                    void onResolve(it.id, { confirmed_class_id: name });
                                  }}
                                >
                                  Подтвердить
                                </button>
                              </>
                            )}
                            {it.category === "inspector_feature_correction" && (
                              <button
                                type="button"
                                className="btn"
                                disabled={busyId === it.id}
                                onClick={() => void onResolve(it.id, { acknowledged_by_expert: true })}
                              >
                                Принять к сведению
                              </button>
                            )}
                          </div>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busyId === it.id}
                            onClick={() => void onDismiss(it.id)}
                            style={{ flex: "0 0 auto", alignSelf: "center" }}
                          >
                            Закрыть без решения
                          </button>
                        </div>
                      ) : it.resolution_json && Object.keys(it.resolution_json).length > 0 ? (
                        <div style={{ fontSize: 13, color: "#64748b" }}>Итог: {formatResolutionRu(it.resolution_json)}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}
