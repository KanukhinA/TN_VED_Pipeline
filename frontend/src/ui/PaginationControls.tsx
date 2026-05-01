import { useMemo } from "react";

type PaginationControlsProps = {
  currentPage: number;
  totalPages: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (nextSize: number) => void;
  summaryText?: string;
};

function buildPageButtons(currentPage: number, totalPages: number): number[] {
  const maxButtons = 7;
  const pages: number[] = [];
  if (totalPages <= maxButtons) {
    for (let p = 1; p <= totalPages; p += 1) pages.push(p);
    return pages;
  }
  pages.push(1);
  const from = Math.max(2, currentPage - 1);
  const to = Math.min(totalPages - 1, currentPage + 1);
  if (from > 2) pages.push(-1);
  for (let p = from; p <= to; p += 1) pages.push(p);
  if (to < totalPages - 1) pages.push(-2);
  pages.push(totalPages);
  return pages;
}

export default function PaginationControls({
  currentPage,
  totalPages,
  loading = false,
  onPageChange,
  pageSize,
  pageSizeOptions = [25, 50, 100],
  onPageSizeChange,
  summaryText,
}: PaginationControlsProps) {
  const safeTotalPages = Math.max(1, totalPages);
  const safeCurrentPage = Math.min(Math.max(1, currentPage), safeTotalPages);
  const pageButtons = useMemo(() => buildPageButtons(safeCurrentPage, safeTotalPages), [safeCurrentPage, safeTotalPages]);

  return (
    <div
      style={{
        borderTop: "1px solid #e2e8f0",
        padding: 12,
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {safeCurrentPage > 1 ? (
          <button type="button" className="btn-secondary" disabled={loading} onClick={() => onPageChange(Math.max(1, safeCurrentPage - 1))}>
            Предыдущая
          </button>
        ) : null}
        {pageButtons.map((p, idx) =>
          p < 0 ? (
            <span key={`ellipsis-${idx}`} style={{ padding: "0 4px", color: "#64748b" }}>
              ...
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={p === safeCurrentPage ? "btn-primary" : "btn-secondary"}
              disabled={loading}
              onClick={() => onPageChange(p)}
              style={{ minWidth: 36, padding: "4px 8px" }}
            >
              {p}
            </button>
          ),
        )}
        {safeCurrentPage < safeTotalPages ? (
          <button type="button" className="btn-secondary" disabled={loading} onClick={() => onPageChange(Math.min(safeTotalPages, safeCurrentPage + 1))}>
            Следующая
          </button>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#64748b", fontSize: 13 }}>
        {summaryText ? <span>{summaryText}</span> : null}
        {typeof pageSize === "number" && onPageSizeChange ? (
          <>
            <span>Строк на странице</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #cbd5e1" }}
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
    </div>
  );
}

