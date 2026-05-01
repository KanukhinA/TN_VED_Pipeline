import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { normalizeTnVedEaeuCode } from "../catalog/tnVedCode";
import { getTnVedParentPrefixesForExpansion, listTnVedChildren, resolveTnVedCodeLabel } from "../catalog/tnVedEaeuTree";
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
  const depthClass = `tnved-tree__row--depth-${Math.min(depth, 4)}`;
  const rowClass = [
    "tnved-tree__row",
    depthClass,
    isSelected ? "tnved-tree__row--selected" : "",
    !isSelected && isMatched ? "tnved-tree__row--match" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        data-tnved-selected={isSelected ? "true" : undefined}
        className={rowClass}
        style={{
          paddingLeft: 6 + depth * 18,
        }}
      >
        <span style={{ width: 22, flexShrink: 0, display: "flex", justifyContent: "center", alignItems: "center" }}>
          {hasChildren ? (
            <button
              type="button"
              className="tnved-tree__expand"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                toggle(code);
              }}
              aria-label={isExpanded ? "Свернуть вложенные позиции" : "Показать вложенные позиции"}
            >
              {isExpanded ? "−" : "+"}
            </button>
          ) : (
            <span style={{ display: "inline-block", width: 22, height: 22 }} aria-hidden />
          )}
        </span>
        <button
          type="button"
          className="tnved-tree__pick"
          disabled={disabled || !isSelectable}
          onClick={() => onPick(code)}
        >
          <span className="fe-font-mono" style={{ fontWeight: 600 }}>
            {displayCode}
          </span>
          <span className="tnved-tree__pick-title"> — {title}</span>
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
  /** id для поля поиска/ввода кода (например, связь с подписью снаружи) */
  searchInputId?: string;
};

/**
 * Иерархический listbox: главы ТН ВЭД → дочерние коды из TN_VED_CHILDREN; раскрытие «+», выбор строки задаёт код.
 */
export default function TnVedEaeuTreeListbox(props: TnVedEaeuTreeListboxProps) {
  const { value, onChange, disabled, searchInputId } = props;
  const selectedNorm = normalizeTnVedEaeuCode(value.trim()) ?? "";
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState(value);
  const [isOpen, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  useEffect(() => {
    const norm = normalizeTnVedEaeuCode(value.trim());
    if (!norm) {
      setQuery(value);
      return;
    }
    const label = resolveTnVedCodeLabel(norm);
    setQuery(label || norm);
  }, [value]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!isOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isOpen]);
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
    if (!isOpen || !selectedNorm || !treeRef.current) return;
    const el = treeRef.current.querySelector("[data-tnved-selected=\"true\"]");
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedNorm, expanded, isOpen]);

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
      if (n) {
        onChange(n);
        setOpen(false);
      }
    },
    [onChange],
  );

  const tryCommitDigitsAsCode = useCallback(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      return;
    }
    const hasLetters = /[a-zA-Zа-яА-ЯёЁ]/.test(trimmed);
    if (hasLetters) return;
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length === 0) return;
    const n = normalizeTnVedEaeuCode(digits);
    if (n) {
      onChange(n);
      setOpen(false);
    } else {
      setQuery(value);
    }
  }, [onChange, query, value]);

  const handleInputBlur = () => {
    tryCommitDigitsAsCode();
    window.setTimeout(() => {
      if (!rootRef.current?.contains(document.activeElement)) {
        setOpen(false);
      }
    }, 0);
  };

  return (
    <div
      ref={rootRef}
      className="tnved-combobox"
      role="group"
      aria-label="Код ТН ВЭД ЕАЭС: ввод и дерево классификатора"
    >
      <div className={`tnved-combobox__trigger${isOpen ? " tnved-combobox__trigger--open" : ""}`}>
        <input
          ref={inputRef}
          id={searchInputId}
          type="text"
          inputMode="search"
          autoComplete="off"
          disabled={disabled}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (!disabled) setOpen(true);
          }}
          onBlur={handleInputBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              tryCommitDigitsAsCode();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              if (!isOpen) {
                onChange("");
                setQuery("");
              }
            }
          }}
          placeholder="Код или поиск по названию"
          className="tnved-combobox__input"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={panelId}
          aria-autocomplete="list"
        />
        <button
          type="button"
          className="tnved-combobox__toggle"
          disabled={disabled}
          tabIndex={-1}
          aria-expanded={isOpen}
          aria-controls={panelId}
          title={isOpen ? "Скрыть дерево" : "Показать дерево классификатора"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setOpen((o) => {
              const next = !o;
              if (next) {
                requestAnimationFrame(() => inputRef.current?.focus());
              }
              return next;
            });
          }}
        >
          <span className="tnved-combobox__toggle-icon" aria-hidden>
            {isOpen ? "▲" : "▼"}
          </span>
        </button>
      </div>
      {isOpen ? (
        <div id={panelId} className="tnved-combobox__panel" role="presentation">
          <div
            ref={treeRef}
            className="tnved-combobox__tree"
            role="tree"
            aria-label="Дерево кодов ТН ВЭД ЕАЭС"
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
      ) : null}
    </div>
  );
}
