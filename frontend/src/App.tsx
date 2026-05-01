import React, { Suspense, lazy } from "react";
import { Navigate, useNavigate, useLocation } from "react-router-dom";
import CatalogUnifiedWizard from "./pages/CatalogUnifiedWizard";
import OfficerValidationPage from "./pages/OfficerValidationPage";

/** Ленивая загрузка: страница тянет xlsx и тяжёлые зависимости — не должна ломать /catalog при старте. */
const FeatureExtractionSettingsPage = lazy(() => import("./pages/FeatureExtractionSettingsPage"));
const ExpertDecisionsPage = lazy(() => import("./pages/ExpertDecisionsPage"));
const ExpertDatabasePage = lazy(() => import("./pages/ExpertDatabasePage"));

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
  const catalogPath = basePath ? `${basePath}/catalog` : "/catalog";
  const catalogSettingsPath = basePath ? `${basePath}/catalog-settings` : "/catalog-settings";
  const generalSettingsPath = basePath ? `${basePath}/general-settings` : "/general-settings";
  const workPath = basePath ? `${basePath}/work` : "/work";
  const archivePath = basePath ? `${basePath}/archive` : "/archive";
  const legacyFeaturePath = basePath ? `${basePath}/feature-extraction` : "/feature-extraction";
  const legacyDecisionsPath = basePath ? `${basePath}/decisions` : "/decisions";
  const legacyDbPath = basePath ? `${basePath}/db` : "/db";

  const p = location.pathname;
  const onCatalogSettings =
    p === catalogSettingsPath || p.startsWith(`${catalogSettingsPath}/`) || p === legacyFeaturePath || p.startsWith(`${legacyFeaturePath}/`);
  const onGeneralSettings = p === generalSettingsPath || p.startsWith(`${generalSettingsPath}/`);
  const onWork = p === workPath || p.startsWith(`${workPath}/`) || p === legacyDecisionsPath || p.startsWith(`${legacyDecisionsPath}/`);
  const onArchive = p === archivePath || p.startsWith(`${archivePath}/`) || p === legacyDbPath || p.startsWith(`${legacyDbPath}/`);
  let expertPage: "catalog" | "catalog-settings" | "general-settings" | "work" | "archive" = "catalog";
  if (onGeneralSettings) {
    expertPage = "general-settings";
  } else if (onCatalogSettings) {
    expertPage = "catalog-settings";
  } else if (onArchive) {
    expertPage = "archive";
  } else if (onWork) {
    expertPage = "work";
  }
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
            color: expertPage === "catalog-settings" ? "#0f172a" : "#64748b",
            fontWeight: expertPage === "catalog-settings" ? 600 : 400,
            borderBottomColor: expertPage === "catalog-settings" ? "#2563eb" : "transparent",
          }}
          onClick={() => navigate(catalogSettingsPath)}
        >
          Настройка справочников
        </button>
        <button
          type="button"
          style={{
            ...expertNavTextBtnBase,
            color: expertPage === "general-settings" ? "#0f172a" : "#64748b",
            fontWeight: expertPage === "general-settings" ? 600 : 400,
            borderBottomColor: expertPage === "general-settings" ? "#2563eb" : "transparent",
          }}
          onClick={() => navigate(`${generalSettingsPath}/semantic`)}
        >
          Общие настройки
        </button>
        <button
          type="button"
          style={{
            ...expertNavTextBtnBase,
            color: expertPage === "work" ? "#0f172a" : "#64748b",
            fontWeight: expertPage === "work" ? 600 : 400,
            borderBottomColor: expertPage === "work" ? "#2563eb" : "transparent",
          }}
          onClick={() => navigate(workPath)}
        >
          Очередь решений
        </button>
        <button
          type="button"
          style={{
            ...expertNavTextBtnBase,
            color: expertPage === "archive" ? "#0f172a" : "#64748b",
            fontWeight: expertPage === "archive" ? 600 : 400,
            borderBottomColor: expertPage === "archive" ? "#2563eb" : "transparent",
          }}
          onClick={() => navigate(archivePath)}
        >
          Архив и проверка
        </button>
      </div>
      {expertPage === "catalog" ? (
        <CatalogUnifiedWizard />
      ) : expertPage === "catalog-settings" || expertPage === "general-settings" ? (
        <Suspense fallback={<div style={{ padding: 16, color: "#64748b" }}>Загрузка настроек извлечения…</div>}>
          <FeatureExtractionSettingsPage />
        </Suspense>
      ) : expertPage === "work" ? (
        <Suspense fallback={<div style={{ padding: 16, color: "#64748b" }}>Загрузка очереди решений…</div>}>
          <ExpertDecisionsPage />
        </Suspense>
      ) : (
        <Suspense fallback={<div style={{ padding: 16, color: "#64748b" }}>Загрузка архива решений…</div>}>
          <ExpertDatabasePage />
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
    if (location.pathname === "/feature-extraction" || location.pathname.startsWith("/feature-extraction/")) {
      return <Navigate to={location.pathname.replace("/feature-extraction", "/catalog-settings")} replace />;
    }
    if (location.pathname === "/decisions" || location.pathname.startsWith("/decisions/")) {
      return <Navigate to={location.pathname.replace("/decisions", "/work")} replace />;
    }
    if (location.pathname === "/db" || location.pathname.startsWith("/db/")) {
      return <Navigate to={location.pathname.replace("/db", "/archive")} replace />;
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
  if (location.pathname === "/expert/feature-extraction" || location.pathname.startsWith("/expert/feature-extraction/")) {
    return <Navigate to={location.pathname.replace("/expert/feature-extraction", "/expert/catalog-settings")} replace />;
  }
  if (location.pathname === "/expert/decisions" || location.pathname.startsWith("/expert/decisions/")) {
    return <Navigate to={location.pathname.replace("/expert/decisions", "/expert/work")} replace />;
  }
  if (location.pathname === "/expert/db" || location.pathname.startsWith("/expert/db/")) {
    return <Navigate to={location.pathname.replace("/expert/db", "/expert/archive")} replace />;
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
