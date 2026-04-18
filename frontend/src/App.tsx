import React, { Suspense, lazy } from "react";
import { Navigate, useNavigate, useLocation } from "react-router-dom";
import CatalogUnifiedWizard from "./pages/CatalogUnifiedWizard";
import OfficerValidationPage from "./pages/OfficerValidationPage";

/** Ленивая загрузка: страница тянет xlsx и тяжёлые зависимости — не должна ломать /catalog при старте. */
const FeatureExtractionSettingsPage = lazy(() => import("./pages/FeatureExtractionSettingsPage"));

const expertNavTextBtnBase: React.CSSProperties = {
  margin: 0,
  padding: "6px 0",
  border: "none",
  borderRadius: 0,
  background: "none",
  cursor: "pointer",
  font: "inherit",
  fontSize: 15,
  lineHeight: 1.4,
  color: "#64748b",
  textDecoration: "none",
  borderBottom: "2px solid transparent",
};

function ExpertTabs({ basePath }: { basePath: "" | "/expert" }) {
  const navigate = useNavigate();
  const location = useLocation();
  const expertPage = location.pathname.includes("feature-extraction") ? "feature-extraction" : "catalog";
  const catalogPath = `${basePath}/catalog` || "/catalog";
  const featurePath = `${basePath}/feature-extraction` || "/feature-extraction";

  return (
    <div className="expert-shell">
      <div style={{ display: "flex", gap: 20, marginBottom: 14, flexWrap: "wrap", alignItems: "baseline" }}>
        <button
          type="button"
          style={{
            ...expertNavTextBtnBase,
            color: expertPage === "catalog" ? "#0f172a" : "#64748b",
            fontWeight: expertPage === "catalog" ? 600 : 400,
            borderBottomColor: expertPage === "catalog" ? "#2563eb" : "transparent",
          }}
          onClick={() => navigate(catalogPath)}
        >
          Создание справочника
        </button>
        <button
          type="button"
          style={{
            ...expertNavTextBtnBase,
            color: expertPage === "feature-extraction" ? "#0f172a" : "#64748b",
            fontWeight: expertPage === "feature-extraction" ? 600 : 400,
            borderBottomColor: expertPage === "feature-extraction" ? "#2563eb" : "transparent",
          }}
          onClick={() => navigate(featurePath)}
        >
          Настройки сервисов
        </button>
      </div>
      {expertPage === "catalog" ? (
        <CatalogUnifiedWizard />
      ) : (
        <Suspense fallback={<div style={{ padding: 16, color: "#64748b" }}>Загрузка настроек извлечения…</div>}>
          <FeatureExtractionSettingsPage />
        </Suspense>
      )}
    </div>
  );
}

export default function App() {
  const uiMode = ((import.meta as any).env?.VITE_UI_MODE ?? "expert") as "expert" | "officer" | "both";
  const navigate = useNavigate();
  const location = useLocation();

  if (uiMode === "officer") {
    return <OfficerValidationPage />;
  }

  if (uiMode === "expert") {
    if (location.pathname === "/" || location.pathname === "/expert") {
      return <Navigate to="/catalog" replace />;
    }
    return <ExpertTabs basePath="" />;
  }

  const page = location.pathname.startsWith("/officer") ? "officer" : "expert";
  const content = page === "expert" ? (
    <ExpertTabs basePath="/expert" />
  ) : (
    <OfficerValidationPage />
  );

  if (location.pathname === "/") {
    return <Navigate to="/expert/catalog" replace />;
  }
  if (location.pathname === "/expert") {
    return <Navigate to="/expert/catalog" replace />;
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <button
          type="button"
          className={page === "expert" ? "btn" : "btn-secondary"}
          onClick={() => navigate("/expert/catalog")}
        >
          Интерфейс эксперта
        </button>
        <button
          type="button"
          className={page === "officer" ? "btn" : "btn-secondary"}
          onClick={() => navigate("/officer")}
        >
          Интерфейс инспектора
        </button>
      </div>
      {content}
    </div>
  );
}
