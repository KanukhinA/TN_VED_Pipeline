import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { normalizeTnVedEaeuCode } from "../catalog/tnVedCode";
import { getTnVedParentPrefixesForExpansion, listTnVedChildren } from "../catalog/tnVedEaeuTree";
import { TN_VED_GROUPS } from "../catalog/tnVedGroupsData";

type NodeProps = {
  code: string;
  title: string;
  depth: number;
  selectedNorm: string;
  disabled?: boolean;
  expanded: Set<string>;
  toggle: (code: string) => void;
  onPick: (code: string) => void;
  matchedCodes?: Set<string>;
  visibleCodes?: Set<string>;
};

function TnVedTreeNode(props: NodeProps) {
  const { code, title, depth, selectedNorm, disabled, expanded, toggle, onPick, matchedCodes, visibleCodes } = props;
  const children = listTnVedChildren(code);
  if (visibleCodes && !visibleCodes.has(code)) return null;
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(code);
  const isSelectable = normalizeTnVedEaeuCode(code) !== null;
  const isSelected = selectedNorm !== "" && selectedNorm === code;
  const syntheticPrefixMatch = code.match(/^\d{4}::group::(\d+)::/);
  const displayCode = isSelectable ? code : syntheticPrefixMatch?.[1] ?? code.replace(/^(\d{4})::group::.*$/, "$1");
  const isMatched = matchedCodes?.has(code) ?? false;
  const levelBackgrounds = ["#dbe4ea", "#e4eaee", "#ebf0f3", "#f1f4f6", "#f6f8f9"];
  const levelBackground = levelBackgrounds[Math.min(depth, levelBackgrounds.length - 1)];

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        data-tnved-selected={isSelected ? "true" : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "1px 6px",
          paddingLeft: 6 + depth * 18,
          borderRadius: 4,
          borderTop: "1px solid rgba(255,255,255,0.9)",
          background: isSelected ? "#dbeafe" : isMatched ? "#fef3c7" : levelBackground,
          fontSize: 12,
          lineHeight: 1.22,
          userSelect: "text",
        }}
      >
        <span style={{ width: 22, flexShrink: 0, display: "flex", justifyContent: "center", alignItems: "center" }}>
          {hasChildren ? (
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                toggle(code);
              }}
              aria-label={isExpanded ? "Свернуть вложенные позиции" : "Показать вложенные позиции"}
              style={{
                width: 22,
                height: 22,
                padding: 0,
                border: "1px solid #94a3b8",
                borderRadius: 4,
                background: "#f8fafc",
                cursor: disabled ? "not-allowed" : "pointer",
                fontSize: 14,
                lineHeight: 1,
                color: "#334155",
              }}
            >
              {isExpanded ? "−" : "+"}
            </button>
          ) : (
            <span style={{ display: "inline-block", width: 22, height: 22 }} aria-hidden />
          )}
        </span>
        <button
          type="button"
          disabled={disabled || !isSelectable}
          onClick={() => onPick(code)}
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            border: "none",
            background: "transparent",
            cursor: disabled || !isSelectable ? "default" : "pointer",
            color: "#0f172a",
            padding: "1px 4px",
            borderRadius: 2,
            userSelect: "text",
          }}
        >
          <span className="fe-font-mono" style={{ fontWeight: 600 }}>
            {displayCode}
          </span>
          <span style={{ color: "#475569" }}> — {title}</span>
        </button>
      </div>
      {hasChildren && isExpanded
        ? children.map((ch) => (
            <TnVedTreeNode
              key={ch.code}
              code={ch.code}
              title={ch.title}
              depth={depth + 1}
              selectedNorm={selectedNorm}
              disabled={disabled}
              expanded={expanded}
              toggle={toggle}
              onPick={onPick}
              matchedCodes={matchedCodes}
              visibleCodes={visibleCodes}
            />
          ))
        : null}
    </>
  );
}

export type TnVedEaeuTreeListboxProps = {
  value: string;
  onChange: (normalizedCode: string) => void;
  disabled?: boolean;
};

/**
 * Иерархический listbox: главы ТН ВЭД → дочерние коды из TN_VED_CHILDREN; раскрытие «+», выбор строки задаёт код.
 */
export default function TnVedEaeuTreeListbox(props: TnVedEaeuTreeListboxProps) {
  const { value, onChange, disabled } = props;
  const selectedNorm = normalizeTnVedEaeuCode(value.trim()) ?? "";
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const treeRef = useRef<HTMLDivElement>(null);
  const normalizeSearchText = useCallback((text: string) => text.toLowerCase().replace(/\s+/g, " ").trim(), []);
  const queryNorm = normalizeSearchText(query);

  const searchState = useMemo(() => {
    if (!queryNorm) return { matchedCodes: null as Set<string> | null, visibleCodes: null as Set<string> | null, autoExpand: [] as string[] };
    const matchedCodes = new Set<string>();
    const visibleCodes = new Set<string>();
    const autoExpand = new Set<string>();
    const visit = (code: string, title: string): boolean => {
      const selfText = normalizeSearchText(`${code} ${title}`);
      const selfMatch = selfText.includes(queryNorm);
      const children = listTnVedChildren(code);
      let childMatch = false;
      for (const child of children) {
        if (visit(child.code, child.title)) childMatch = true;
      }
      if (selfMatch) matchedCodes.add(code);
      if (selfMatch || childMatch) {
        visibleCodes.add(code);
        if (childMatch) autoExpand.add(code);
        return true;
      }
      return false;
    };
    for (const group of TN_VED_GROUPS) visit(group.code, group.title);
    return { matchedCodes, visibleCodes, autoExpand: Array.from(autoExpand) };
  }, [normalizeSearchText, queryNorm]);

  useEffect(() => {
    const parents = getTnVedParentPrefixesForExpansion(value);
    if (parents.length === 0) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      parents.forEach((p) => next.add(p));
      return next;
    });
  }, [value]);

  useEffect(() => {
    if (!searchState.autoExpand.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      searchState.autoExpand.forEach((code) => next.add(code));
      return next;
    });
  }, [searchState.autoExpand]);

  useLayoutEffect(() => {
    if (!selectedNorm || !treeRef.current) return;
    const el = treeRef.current.querySelector("[data-tnved-selected=\"true\"]");
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedNorm, expanded]);

  const toggle = useCallback((code: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  const onPick = useCallback(
    (code: string) => {
      const n = normalizeTnVedEaeuCode(code);
      if (n) onChange(n);
    },
    [onChange],
  );

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Поиск по коду или названию"
        style={{
          width: "100%",
          marginBottom: 8,
          padding: 8,
          borderRadius: 8,
          border: "1px solid #cbd5e1",
          background: "#fff",
        }}
      />
      <div
        ref={treeRef}
        role="tree"
        aria-label="Дерево кодов ТН ВЭД ЕАЭС"
        style={{
          width: "100%",
          boxSizing: "border-box",
          border: "1px solid #cbd5e1",
          borderRadius: 10,
          maxHeight: "min(28vh, 15rem)",
          overflow: "auto",
          background: "#fff",
          padding: "2px 0",
          userSelect: "text",
        }}
      >
        {TN_VED_GROUPS.map((g) => (
          <TnVedTreeNode
            key={g.code}
            code={g.code}
            title={g.title}
            depth={0}
            selectedNorm={selectedNorm}
            disabled={disabled}
            expanded={expanded}
            toggle={toggle}
            onPick={onPick}
            matchedCodes={searchState.matchedCodes ?? undefined}
            visibleCodes={searchState.visibleCodes ?? undefined}
          />
        ))}
      </div>
    </div>
  );
}
