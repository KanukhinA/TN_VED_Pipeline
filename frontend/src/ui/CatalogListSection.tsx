/* eslint-disable @typescript-eslint/no-explicit-any */
import React from "react";

export interface CatalogListSectionProps {
  catalogs: any[];
  catalogQuery: string;
  onCatalogQueryChange: (q: string) => void;
  includeArchived: boolean;
  onIncludeArchivedChange: (v: boolean) => void;
  busy: boolean;
  onOpenPrimary: (ruleId: string) => void;
  onOpenValidate: (ruleId: string) => void;
  onClone: (ruleId: string) => void;
  onQuickValidate: (ruleId: string) => void;
  onArchive: (ruleId: string) => void;
  onUnarchive: (ruleId: string) => void;
  onDelete: (ruleId: string) => void;
  /** Подписи кнопки «открыть для редактирования» */
  openPrimaryLabel?: string;
  openValidateLabel?: string;
}

export default function CatalogListSection(props: CatalogListSectionProps) {
  const {
    catalogs,
    catalogQuery,
    onCatalogQueryChange,
    includeArchived,
    onIncludeArchivedChange,
    busy,
    onOpenPrimary,
    onOpenValidate,
    onClone,
    onQuickValidate,
    onArchive,
    onUnarchive,
    onDelete,
    openPrimaryLabel = "Редактировать",
    openValidateLabel = "Проверка",
  } = props;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>Справочники</h3>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input
          type="search"
          placeholder="Поиск: имя или model_id"
          value={catalogQuery}
          onChange={(e) => onCatalogQueryChange(e.target.value)}
          style={{ flex: "1 1 min(12rem, 100%)", minWidth: 0, width: "100%", maxWidth: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #cbd5e1" }}
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            cursor: "pointer",
            userSelect: "none",
            lineHeight: 1.2,
          }}
        >
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => onIncludeArchivedChange(e.target.checked)}
            style={{ margin: 0, width: 14, height: 14, flexShrink: 0 }}
          />
          Показать архивные
        </label>
      </div>
      {catalogs.length === 0 ? (
        <div>Справочников не найдено.</div>
      ) : (
        catalogs.map((c) => (
          <div
            key={c.rule_id}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: 10,
              marginBottom: 8,
              opacity: c.is_archived ? 0.85 : 1,
              background: c.is_archived ? "#f8fafc" : undefined,
            }}
          >
            <div>
              {c.tn_ved_group_code ? (
                <span
                  title="Группа ТН ВЭД ЕАЭС"
                  style={{
                    display: "inline-block",
                    marginRight: 8,
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: "#e0f2fe",
                    color: "#0369a1",
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  ТН ВЭД {c.tn_ved_group_code}
                </span>
              ) : null}
              <strong>{c.name || "(без названия)"}</strong>
              {" · "}
              <code>{c.model_id}</code>
              {" · "}v{c.version}
              {c.is_archived ? (
                <span style={{ marginLeft: 8, fontSize: 12, color: "#64748b" }}>в архиве</span>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap", alignItems: "center", width: "100%" }}>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void onOpenPrimary(c.rule_id)}>
                {openPrimaryLabel}
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void onOpenValidate(c.rule_id)}>
                {openValidateLabel}
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void onClone(c.rule_id)}>
                Клонировать
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void onQuickValidate(c.rule_id)}>
                Проверить примером
              </button>
              {c.is_archived ? (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void onUnarchive(c.rule_id)}>
                  Из архива
                </button>
              ) : (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void onArchive(c.rule_id)}>
                  В архив
                </button>
              )}
              <button
                type="button"
                className="btn-danger btn-align-end"
                disabled={busy}
                onClick={() => void onDelete(c.rule_id)}
              >
                Удалить
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
