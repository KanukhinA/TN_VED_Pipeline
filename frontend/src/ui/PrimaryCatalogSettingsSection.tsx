import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getPrimaryCatalogSettings, listRules, putPrimaryCatalogSettings } from "../api/client";

type RuleRow = {
  rule_id: string;
  name?: string | null;
  model_id?: string | null;
  tn_ved_group_code?: string | null;
};

function groupByTnVed(rules: RuleRow[]): Record<string, RuleRow[]> {
  const g: Record<string, RuleRow[]> = {};
  for (const r of rules) {
    const code = String(r.tn_ved_group_code ?? "").trim();
    if (!code) continue;
    if (!g[code]) g[code] = [];
    g[code].push(r);
  }
  return g;
}

function mergeDraftForGroups(
  server: Record<string, string>,
  grouped: Record<string, RuleRow[]>,
): Record<string, string> {
  const out: Record<string, string> = { ...server };
  for (const [code, items] of Object.entries(grouped)) {
    if (items.length < 1) continue;
    const cur = out[code];
    const ok = cur && items.some((x) => String(x.rule_id) === cur);
    if (!ok) out[code] = String(items[0].rule_id);
  }
  return out;
}

function ruleLabel(r: RuleRow): string {
  const n = (r.name || "").trim();
  if (n) return n;
  const m = (r.model_id || "").trim();
  if (m) return m;
  const id = String(r.rule_id);
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export default function PrimaryCatalogSettingsSection() {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [serverMap, setServerMap] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const grouped = useMemo(() => groupByTnVed(rules), [rules]);

  const rows = useMemo(() => {
    return Object.keys(grouped)
      .sort((a, b) => a.localeCompare(b, "ru", { numeric: true }))
      .map((code) => ({ code, items: grouped[code] }));
  }, [grouped]);

  const load = useCallback(async () => {
    setStatus(null);
    let list: RuleRow[] = [];
    try {
      const rlist = await listRules();
      list = Array.isArray(rlist) ? (rlist as RuleRow[]) : [];
      setRules(list);
    } catch (e: any) {
      setRules([]);
      setServerMap({});
      setDraft({});
      setStatus(e?.message ?? "Не удалось загрузить справочники.");
      return;
    }

    let sm: Record<string, string> = {};
    try {
      const cfg = await getPrimaryCatalogSettings();
      sm = cfg?.by_group_code && typeof cfg.by_group_code === "object" ? cfg.by_group_code : {};
      setServerMap(sm);
    } catch (e: any) {
      setServerMap({});
      const detail = String(e?.message ?? "").trim() || "Неизвестная ошибка";
      setStatus(
        `${detail}. Список справочников загружен; сохранённые привязки основного недоступны — проверьте backend (маршрут GET /api/feature-extraction/primary-catalog-settings) и прокси.`,
      );
    }

    const g = groupByTnVed(list);
    setDraft(mergeDraftForGroups(sm, g));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSave() {
    const byGroup: Record<string, string> = {};
    for (const { code, items } of rows) {
      const sel = draft[code] || String(items[0].rule_id);
      byGroup[code] = sel;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await putPrimaryCatalogSettings(byGroup);
      const next = res?.by_group_code && typeof res.by_group_code === "object" ? res.by_group_code : byGroup;
      setServerMap(next);
      setDraft(mergeDraftForGroups(next, groupByTnVed(rules)));
      setStatus("Настройки сохранены.");
      window.setTimeout(() => setStatus(null), 4000);
    } catch (e: any) {
      setStatus(e?.message ?? "Ошибка сохранения.");
    } finally {
      setBusy(false);
    }
  }

  const dirty = useMemo(() => {
    const a = JSON.stringify(serverMap);
    const b: Record<string, string> = {};
    for (const { code, items } of rows) {
      b[code] = draft[code] || String(items[0].rule_id);
    }
    return a !== JSON.stringify(b);
  }, [serverMap, draft, rows]);

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", display: "grid", gap: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "#0f172a" }}>
          Основной справочник по категории ТН ВЭД
        </h2>

        {rows.length === 0 ? (
          <p style={{ margin: 0, color: "#64748b", fontSize: 14, lineHeight: 1.55 }}>
            В таблице только справочники с непустым <code style={{ fontSize: 13 }}>meta.tn_ved_group_code</code> у
            активной версии (код группы ТН ВЭД). Если справочники уже есть, но список пуст — откройте каждый в «Создание
            справочника» и задайте код группы в метаданных; при необходимости снимите с архива.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "8px 6px", color: "#475569", fontWeight: 600 }}>Код группы ТН ВЭД</th>
                  <th style={{ padding: "8px 6px", color: "#475569", fontWeight: 600 }}>Справочники</th>
                  <th style={{ padding: "8px 6px", color: "#475569", fontWeight: 600 }}>Основной</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ code, items }) => {
                  const multi = items.length >= 2;
                  const value = draft[code] || String(items[0].rule_id);
                  return (
                    <tr key={code} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "10px 6px", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                        {code}
                      </td>
                      <td style={{ padding: "10px 6px", color: "#334155" }}>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {items.map((r) => (
                            <li key={String(r.rule_id)}>{ruleLabel(r)}</li>
                          ))}
                        </ul>
                      </td>
                      <td style={{ padding: "10px 6px", verticalAlign: "middle" }}>
                        <select
                          value={value}
                          disabled={!multi}
                          title={multi ? "Основной справочник для этой группы" : "В группе один справочник — он и есть основной"}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              [code]: e.target.value,
                            }))
                          }
                          style={{
                            minWidth: 220,
                            maxWidth: "100%",
                            padding: "6px 8px",
                            borderRadius: 6,
                            border: "1px solid #cbd5e1",
                            background: multi ? "#fff" : "#f8fafc",
                            color: "#0f172a",
                          }}
                        >
                          {items.map((r) => (
                            <option key={String(r.rule_id)} value={String(r.rule_id)}>
                              {ruleLabel(r)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <button type="button" className="btn" disabled={busy || !dirty || rows.length === 0} onClick={() => void onSave()}>
            {busy ? "Сохранение..." : "Сохранить основной справочник"}
          </button>
          <button
            type="button"
            className="btn"
            style={{ background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1" }}
            disabled={busy}
            onClick={() => void load()}
          >
            Обновить список
          </button>
        </div>

        {status ? (
          <div
            style={{
              color:
                status.includes("Ошибка") ||
                status.includes("ошибка") ||
                status.includes("Не удалось") ||
                /not\s*found/i.test(status) ||
                status.includes("404") ||
                status.includes("проверьте backend")
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
  );
}
