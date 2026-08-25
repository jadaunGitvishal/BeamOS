import { Route, Routes } from "react-router-dom";
import { ToastProvider } from "./context/ToastContext";
import { PeriodProvider } from "./context/PeriodContext";
import { SessionProvider } from "./context/SessionContext";
import { BreadcrumbProvider } from "./context/BreadcrumbContext";
import { useSession } from "./hooks/useSession";
import AuthPlaceholder from "./components/AuthPlaceholder";
import Shell from "./components/Shell";
import OverviewView from "./views/OverviewView";
import DevicesView from "./views/DevicesView";
import DeviceDetailView from "./views/DeviceDetailView";
import ContentView from "./views/ContentView";
import IssuesView from "./views/IssuesView";

export default function App() {
  return (
    <ToastProvider>
      <PeriodProvider>
        <SessionProvider>
          <BreadcrumbProvider>
            <SessionGate />
          </BreadcrumbProvider>
        </SessionProvider>
      </PeriodProvider>
    </ToastProvider>
  );
}

function SessionGate() {
  const { authState } = useSession();

  // Mirrors the vanilla boot() sequence: the shell stays blank until
  // /api/me resolves, then either shows the real dashboard or (phase 1,
  // no login page) the placeholder.
  if (authState === "loading") return null;
  if (authState === "unauthenticated") return <AuthPlaceholder />;

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<OverviewView />} />
        <Route path="overview" element={<OverviewView />} />
        <Route path="devices" element={<DevicesView />} />
        <Route path="device/:id" element={<DeviceDetailView />} />
        <Route path="content" element={<ContentView />} />
        <Route path="issues" element={<IssuesView />} />
        <Route path="*" element={<OverviewView />} />
      </Route>
    </Routes>
  );
}
