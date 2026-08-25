import { useContext } from "react";
import { BreadcrumbContext } from "../context/BreadcrumbContext";

export function useBreadcrumb() {
  const ctx = useContext(BreadcrumbContext);
  if (!ctx) throw new Error("useBreadcrumb must be used within BreadcrumbProvider");
  return ctx;
}
