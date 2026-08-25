import { createContext, useState } from "react";

export const BreadcrumbContext = createContext(null);

export function BreadcrumbProvider({ children }) {
  const [deviceCrumbName, setDeviceCrumbName] = useState(null);
  return (
    <BreadcrumbContext.Provider value={{ deviceCrumbName, setDeviceCrumbName }}>{children}</BreadcrumbContext.Provider>
  );
}
