/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CatalogListSectionProps {
  catalogs: any[];
  /** Соответствие кода группы ТН ВЭД → rule_id основного справочника (как на сервере). */
  primaryByGroup?: Record<string, string> | null;
  catalogQuery: string;
  onCatalogQueryChange: (q: string) => void;
  includeArchived: boolean;
  onIncludeArchivedChange: (v: boolean) => void;
  busy: boolean;
  onOpenPrimary: (ruleId: string) => void;
  onClone: (ruleId: string) => void;
  onArchive: (ruleId: string) => void;
  onUnarchive: (ruleId: string) => void;
  onDelete: (ruleId: string) => void;
  /** Подписи кнопки «открыть для редактирования» */
  openPrimaryLabel?: string;
}

export default function CatalogListSection(props: CatalogListSectionProps) {
  const {
    catalogs,
    primaryByGroup,
    catalogQuery,
    onCatalogQueryChange,
    includeArchived,
    onIncludeArchivedChange,
    busy,
    onOpenPrimary,
    onClone,
    onArchive,
    onUnarchive,
    onDelete,
    openPrimaryLabel = "Редактировать",
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
        <div
          style={{
            maxHeight: "min(52vh, 480px)",
            overflow: "auto",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
            background: "#fafafa",
          }}
        >
          {catalogs.map((c, rowIdx) => {
            const groupCode = String(c.tn_ved_group_code ?? "").trim();
            const primaryId =
              groupCode && primaryByGroup ? String(primaryByGroup[groupCode] ?? "").trim() : "";
            const ruleIdStr = String(c.rule_id ?? "").trim().toLowerCase();
            const isPrimaryForCategory = Boolean(
              groupCode && primaryId && ruleIdStr && primaryId.toLowerCase() === ruleIdStr,
            );

            return (
              <div
                key={c.rule_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  flexWrap: "nowrap",
                  padding: "8px 10px",
                  borderBottom: rowIdx < catalogs.length - 1 ? "1px solid #e5e7eb" : undefined,
                  opacity: c.is_archived ? 0.85 : 1,
                  background: c.is_archived ? "#f1f5f9" : "#fff",
                  minHeight: 44,
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    flex: "1 1 0",
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    overflow: "hidden",
                  }}
                >
                  {c.tn_ved_group_code ? (
                    <span
                      title="Группа ТН ВЭД ЕАЭС"
                      style={{
                        flexShrink: 0,
                        padding: "2px 8px",
                        borderRadius: 6,
                        background: "#e0f2fe",
                        color: "#0369a1",
                        fontWeight: 600,
                        fontSize: 12,
                        whiteSpace: "nowrap",
                      }}
                    >
                      ТН ВЭД {c.tn_ved_group_code}
                    </span>
                  ) : null}
                  {isPrimaryForCategory ? (
                    <span
                      title="Этот справочник задан как основной для данной категории (группы ТН ВЭД). Сменить выбор: раздел «Общие настройки» → «Семантическая проверка» → блок «Основной справочник по категории ТН ВЭД»."
                      style={{
                        flexShrink: 0,
                        padding: "2px 8px",
                        borderRadius: 6,
                        background: "#ecfdf5",
                        color: "#047857",
                        fontWeight: 600,
                        fontSize: 12,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Основной
                    </span>
                  ) : null}
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                      fontSize: 14,
                      color: "#0f172a",
                    }}
                  >
                    <strong>{c.name || "(без названия)"}</strong>
                    <span style={{ color: "#64748b", fontWeight: 400 }}>
                      {" "}
                      · <code style={{ fontSize: 13 }}>{c.model_id}</code> · v{c.version}
                      {c.is_archived ? <span style={{ fontSize: 12 }}> · в архиве</span> : null}
                    </span>
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexShrink: 0,
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "nowrap",
                  }}
                >
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    style={{ padding: "4px 10px", fontSize: 13, whiteSpace: "nowrap" }}
                    onClick={() => void onOpenPrimary(c.rule_id)}
                  >
                    {openPrimaryLabel}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    style={{ padding: "4px 10px", fontSize: 13, whiteSpace: "nowrap" }}
                    onClick={() => void onClone(c.rule_id)}
                  >
                    Клонировать
                  </button>
                  {c.is_archived ? (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy}
                      style={{ padding: "4px 10px", fontSize: 13, whiteSpace: "nowrap" }}
                      onClick={() => void onUnarchive(c.rule_id)}
                    >
                      Из архива
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy}
                      style={{ padding: "4px 10px", fontSize: 13, whiteSpace: "nowrap" }}
                      onClick={() => void onArchive(c.rule_id)}
                    >
                      В архив
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={busy}
                    style={{ padding: "4px 10px", fontSize: 13, whiteSpace: "nowrap" }}
                    onClick={() => void onDelete(c.rule_id)}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
