import { useEffect } from "react";
import { createBrowserRouter, Navigate, useParams } from "react-router";
import { Center, Spinner } from "@chakra-ui/react";
import { Layout } from "./components/Layout";
import { useSession } from "./session";
import { HOME } from "./home";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { StockPage } from "./pages/Stock";
import { BatchPage } from "./pages/Batch";
import { AcceptancePage } from "./pages/Acceptance";
import { KitchenPage } from "./pages/Kitchen";
import { CashierPage } from "./pages/Cashier";
import { MenuPage } from "./pages/Menu";
import { HotPage } from "./pages/Hot";
import { PurchasesPage } from "./pages/Purchases";
import { WriteoffsPage } from "./pages/Writeoffs";
import { InventoryPage } from "./pages/Inventory";
import { AnalyticsPage } from "./pages/Analytics";
import { AnomaliesPage } from "./pages/Anomalies";
import { LedgerPage } from "./pages/Ledger";
import { RecipesPage } from "./pages/Recipes";
import { AdminPage } from "./pages/Admin";
import { DemoPage } from "./pages/Demo";
import { DocsPage } from "./pages/Docs";
import { TracePage } from "./pages/Trace";
import { InvitePage } from "./pages/Invite";
import { NoTenantPage } from "./components/Tenants";
import { PlatformPage } from "./pages/Platform";
import type { Role } from "./types";

function Home() {
  const { me, loc } = useSession();
  if (me === undefined) return <Center h="100vh"><Spinner /></Center>;
  if (me === null) return <Navigate to="/login" replace />;
  // Вошёл, но ещё ни в одном предприятии (ТЗ 16.9, 16.14): принять приглашение или подать заявку на своё.
  // Администратор платформы без своего предприятия сразу попадает в админку платформы.
  if (me.tenantId === 0) return me.platformAdmin ? <Navigate to="/platform" replace /> : <NoTenantPage />;
  if (!loc) return <Center h="100vh"><Spinner /></Center>;
  return <Navigate to={`/${loc}/${HOME[me.role as Role]}`} replace />;
}

function Shell() {
  const { me, loc, setLoc } = useSession();
  const params = useParams();
  useEffect(() => {
    if (params.loc && params.loc !== loc) setLoc(params.loc);
  }, [params.loc, loc, setLoc]);
  if (me === undefined) return <Center h="100vh"><Spinner /></Center>;
  if (me === null) return <Navigate to="/login" replace />;
  if (me.tenantId === 0) return <NoTenantPage />;
  // Пока точка не определена, экраны не рендерим — иначе запросы уйдут без точки.
  if (!loc || (params.loc && params.loc !== loc)) return <Center h="100vh"><Spinner /></Center>;
  return <Layout />;
}

export const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/invite/:token", element: <InvitePage /> },
  { path: "/platform", element: <PlatformPage /> },
  {
    path: "/:loc",
    element: <Shell />,
    children: [
      { path: "dashboard", element: <DashboardPage /> },
      // Кассы во Флагмане нет — по старой ссылке кассир узнаёт, где она: в панели ресторана
      { path: "pos", element: <CashierPage /> },
      { path: "kitchen", element: <KitchenPage /> },
      { path: "stock", element: <StockPage /> },
      { path: "batches/:id", element: <BatchPage /> },
      { path: "acceptance", element: <AcceptancePage /> },
      { path: "menu", element: <MenuPage /> },
      { path: "hot", element: <HotPage /> },
      { path: "purchases", element: <PurchasesPage /> },
      { path: "writeoffs", element: <WriteoffsPage /> },
      { path: "inventory", element: <InventoryPage /> },
      { path: "analytics", element: <AnalyticsPage /> },
      { path: "trace", element: <TracePage /> },
      { path: "anomalies", element: <AnomaliesPage /> },
      { path: "ledger", element: <LedgerPage /> },
      { path: "recipes", element: <RecipesPage /> },
      { path: "admin", element: <AdminPage /> },
      { path: "demo", element: <DemoPage /> },
      { path: "docs", element: <DocsPage /> },
      { index: true, element: <Home /> },
    ],
  },
  { path: "*", element: <Home /> },
]);
