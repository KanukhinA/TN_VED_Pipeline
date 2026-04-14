import React from "react";
import { getTnVedGroup, TN_VED_GROUPS } from "../catalog/tnVedGroupsData";
import { normalizeTnVedChapterMeta } from "../catalog/tnVedCode";

export type TnVedGroupSelectProps = {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  id?: string;
};

/**
 * Только глава ТН ВЭД (01–97). Справочник задаётся на всю группу; точный код — в классах (TnVedEaeuPicker и т.п.).
 */
export default function TnVedGroupSelect(props: TnVedGroupSelectProps) {
  const { value, onChange, disabled, id } = props;
  const chapter = normalizeTnVedChapterMeta(value.trim()) ?? "";
  const selectedChapter = chapter ? getTnVedGroup(chapter) : undefined;

  return (
    <div>
      <label
        htmlFor={id}
        style={{ display: "block", fontWeight: 600, marginBottom: 6, fontSize: 13 }}
      >
        Глава ТН ВЭД (группа 01–97) <span style={{ color: "#b91c1c" }}>*</span>
      </label>
      <p style={{ margin: "0 0 10px", fontSize: 13, color: "#64748b", lineHeight: 1.45 }}>
        Справочник создаётся для всей группы кодов. Точный код ТН ВЭД ЕАЭС задаётся при настройке классов.
      </p>
      <select
        id={id}
        disabled={disabled}
        value={chapter}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          maxWidth: "min(36rem, 100%)",
          padding: "10px 12px",
          borderRadius: 8,
          border: "1px solid #cbd5e1",
          fontSize: 14,
          background: "#fff",
        }}
      >
        <option value="">(не выбрано)</option>
        {TN_VED_GROUPS.map((g) => (
          <option key={g.code} value={g.code}>
            {g.code} — {g.title}
          </option>
        ))}
      </select>
      {selectedChapter?.description ? (
        <p
          title={selectedChapter.description}
          style={{
            marginTop: 10,
            fontSize: 13,
            color: "#475569",
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            maxHeight: 140,
            overflow: "auto",
            padding: 8,
            background: "#f8fafc",
            borderRadius: 8,
            border: "1px solid #e2e8f0",
          }}
        >
          {selectedChapter.description}
        </p>
      ) : null}
    </div>
  );
}
